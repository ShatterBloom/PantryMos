// Read models for the web view (IMPLEMENTATION_PLAN §4.4, §8.8): the inventory and the ledger.
import { householdToday, type Queryable } from '../db/catalog.ts';
import { activeBatches } from '../db/inventory.ts';
import type { ProposalKind } from '../db/proposals.ts';
import { itemInfo } from '../db/sessions.ts';
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
