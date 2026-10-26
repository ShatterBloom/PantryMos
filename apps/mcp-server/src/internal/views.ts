// Read models for the web view (IMPLEMENTATION_PLAN §4.4, §8.8): the inventory and the ledger.
import { householdToday, type Queryable } from '../db/catalog.ts';
import { activeBatches } from '../db/inventory.ts';
import { type ProposalKind, type ProposalView, proposalView } from '../db/proposals.ts';
import { itemInfo } from '../db/sessions.ts';
import { dateLabel, type PackageDateType } from '../domain/dates.ts';
import { describeOperation } from '../domain/operations.ts';
import { groupByItem } from '../mcp/tools/listInventory.ts';

/** Whether the household exists: views take it from a header, not from a proposal row (§11.3). */
export async function householdExists(q: Queryable, householdId: string): Promise<boolean> {
  const { rowCount } = await q.query(`SELECT 1 FROM pantry.households WHERE id = $1`, [householdId]);
  return rowCount === 1;
}

/**
 * What is in stock, as list_inventory reports it, plus the open shopping list: oldest first, and
 * by name among rows added together (one call's rows share their created_at).
 */
export async function inventoryView(q: Queryable, householdId: string) {
  const today = await householdToday(q, householdId);
  const items = groupByItem(await activeBatches(q, householdId, today));
  const { rows: shopping } = await q.query<{ id: string; item: string; quantity: string | null; unit: string | null; source: string }>(
    `SELECT s.id, COALESCE(i.name, s.free_text) AS item, s.quantity::text AS quantity, s.unit, s.source
       FROM pantry.shopping_list_items s
       LEFT JOIN pantry.items i ON i.id = s.item_id
      WHERE s.household_id = $1 AND NOT s.done
      ORDER BY s.created_at, COALESCE(i.name, s.free_text), s.id`,
    [householdId],
  );
  return {
    today,
    items,
    shopping_list: shopping.map((s) => ({ ...s, quantity: s.quantity === null ? null : Number(s.quantity) })),
  };
}

/** The most cards the inbox lists at once. */
const PENDING_LIMIT = 50;

/**
 * Pending cards, oldest first, each as the card shows it. `client` names the MCP client that made
 * it when the card is in that client's own conversation (one sent without `_meta`, see readRequestMeta).
 */
export async function pendingView(q: Queryable, householdId: string) {
  const { rows } = await q.query<{ id: string; client: string | null }>(
    `SELECT p.id, c.name AS client
       FROM pantry.proposals p
       LEFT JOIN pantry.api_clients c ON c.id = p.conversation_id AND c.household_id = p.household_id
      WHERE p.household_id = $1 AND p.status = 'pending' AND p.expires_at > now()
      ORDER BY p.created_at, p.id
      LIMIT $2`,
    [householdId, PENDING_LIMIT],
  );
  const proposals: Array<ProposalView & { client: string | null }> = [];
  for (const row of rows) {
    const view = await proposalView(q, row.id);
    if (view?.status === 'pending') proposals.push({ ...view, client: row.client });
  }
  return { proposals };
}

interface LedgerRow {
  operation_id: string;
  kind: ProposalKind;
  recipe: string | null;
  proposal_id: string;
  proposal_version: number;
  reverted_by: string | null;
  reverts_operation_ids: string[];
  created_at: Date;
  channel: 'ui_click' | 'voice_rule';
  utterance: string | null;
  user_id: string;
  changes: Array<{ item_id: string; delta: string }>;
}

/**
 * Committed operations, newest first: what changed, which card version was confirmed, and how
 * (a button, or the voice phrase the gate matched, §8.5 audit). Reverted ones say by what.
 */
export async function ledgerView(q: Queryable, householdId: string, limit: number) {
  const items = await itemInfo(q, householdId);
  const { rows } = await q.query<LedgerRow>(
    `SELECT o.id AS operation_id, o.kind, r.name AS recipe, o.proposal_id, o.proposal_version,
            o.reverted_by_op AS reverted_by, o.reverts_operation_ids, o.created_at,
            c.channel, c.utterance, c.user_id,
            COALESCE((SELECT json_agg(json_build_object('item_id', e.item_id, 'delta', e.delta::text) ORDER BY e.item_id)
                        FROM (SELECT item_id, sum(delta) AS delta FROM pantry.inventory_events
                               WHERE operation_id = o.id GROUP BY item_id HAVING sum(delta) <> 0) e), '[]') AS changes
       FROM pantry.operations o
       JOIN pantry.confirmations c ON c.id = o.confirmation_id
       LEFT JOIN pantry.cooking_sessions s ON s.id = o.session_id
       LEFT JOIN pantry.recipes r ON r.id = s.recipe_id
      WHERE o.household_id = $1
      ORDER BY o.created_at DESC, o.id
      LIMIT $2`,
    [householdId, limit],
  );
  return {
    used_first: await usedFirst(q, householdId, items),
    operations: rows.map((r) => {
      const changes = r.changes.map((c) => {
        const item = items.get(c.item_id)!;
        return { item: item.name, delta: Number(c.delta), unit: item.base_unit };
      });
      return {
        operation_id: r.operation_id,
        kind: r.kind,
        summary: describeOperation(r.kind, r.recipe, changes),
        changes,
        proposal_id: r.proposal_id,
        proposal_version: r.proposal_version,
        confirmed: { channel: r.channel, utterance: r.utterance, user_id: r.user_id },
        reverted_by: r.reverted_by,
        reverts_operation_ids: r.reverts_operation_ids,
        created_at: r.created_at.toISOString(),
      };
    }),
  };
}

/** The "used first" summary (FR-24): meals of the last week, and the window expiring_soon uses. */
export const USED_FIRST_DAYS = 7;
export const DUE_SOON_DAYS = 3;

interface UsedRow {
  batch_id: string;
  item_id: string;
  purchased_at: string;
  opened_at: string | null;
  package_date: string | null;
  package_date_type: PackageDateType | null;
  used: string;
  used_on: string;
  operation_ids: string[];
}

/**
 * Batches meals used while they were due soon, over the last week: what was saved from going bad.
 * Undone meals and corrections don't count, and a correction that gave stock back counts net.
 * Each batch's date label is as of the day it was last used, and names the operations behind it.
 */
async function usedFirst(q: Queryable, householdId: string, items: Awaited<ReturnType<typeof itemInfo>>) {
  const { rows } = await q.query<UsedRow>(
    `SELECT b.id AS batch_id, b.item_id, b.purchased_at::text, b.opened_at::text, b.package_date::text, b.package_date_type,
            (-sum(e.delta))::text AS used,
            max((o.created_at AT TIME ZONE h.timezone)::date)::text AS used_on,
            array_agg(DISTINCT o.id) AS operation_ids
       FROM pantry.inventory_events e
       JOIN pantry.operations o ON o.id = e.operation_id
       JOIN pantry.batches b ON b.id = e.batch_id
       JOIN pantry.households h ON h.id = o.household_id
      WHERE o.household_id = $1
        AND e.reason IN ('consume', 'consume_revision')
        AND o.reverted_by_op IS NULL
        AND o.created_at >= now() - make_interval(days => $2)
        AND b.priority_date <= (o.created_at AT TIME ZONE h.timezone)::date + $3::int
      GROUP BY b.id
     HAVING sum(e.delta) < 0
      ORDER BY min(b.priority_date), b.id`,
    [householdId, USED_FIRST_DAYS, DUE_SOON_DAYS],
  );
  return {
    days: USED_FIRST_DAYS,
    batches: rows.map((r) => {
      const item = items.get(r.item_id)!;
      return {
        batch_id: r.batch_id,
        item: item.name,
        quantity: Number(r.used),
        unit: item.base_unit,
        date_label: dateLabel(r, r.used_on),
        operation_ids: r.operation_ids,
      };
    }),
  };
}
