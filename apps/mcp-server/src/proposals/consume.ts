// Consumption proposals (IMPLEMENTATION_PLAN §3.1, §4.2, §6.4): what the user used, pinned to batches.
import { canonicalJson } from '@pantrymos/shared';
import { z } from 'zod';
import { householdToday, loadCatalog } from '../db/catalog.ts';
import { activeBatches, type BatchView } from '../db/inventory.ts';
import { pendingProposal, type ProposalRef, upsertProposal } from '../db/proposals.ts';
import { consumeSubject, itemInfo, lockActiveSession, type SessionRow } from '../db/sessions.ts';
import type { Tx } from '../db/tx.ts';
import { type AllocationLine, allocateFefo } from '../domain/allocation.ts';
import { type Card, CONFIRM_PROMPT } from '../domain/card.ts';
import { demandByItem } from '../domain/cooking.ts';
import { PantryError } from '../domain/errors.ts';
import { MAX_QUANTITY } from '../domain/intake.ts';
import { type BaseUnit, findItem } from '../domain/items.ts';
import { listAnd, speakQuantity } from '../domain/speech.ts';
import { normalizeName } from '../domain/text.ts';
import { NameInput } from '../mcp/schemas.ts';

/** "I used 3 eggs": a total for one item, in base units; 0 removes the line. */
export const ConsumeOverrides = z
  .array(z.object({ item: NameInput, quantity: z.number().min(0).max(MAX_QUANTITY).describe('Base units') }))
  .max(20);

export interface ConsumeInput {
  session_id?: string | undefined;
  /** Replace a line's quantity; 0 removes it. Items not in the plan are added. */
  overrides?: Array<{ item: string; quantity: number }> | undefined;
}

export interface ConsumeLine {
  item_id: string;
  item: string;
  unit: BaseUnit;
  quantity: number;
}

export interface ConsumePayload {
  lines: ConsumeLine[];
  allocation: AllocationLine[];
  card: Card;
}

export interface ConsumePreconditions {
  session: { id: string; state: 'awaiting_confirmation'; state_version: number };
  /** Every batch the allocation touches, with the version it was planned against. */
  batches: Array<{ id: string; version: number }>;
}

export interface ProposedConsumption extends ProposalRef {
  card: Card;
}

/**
 * Proposes the consumption card for the active (or given) session (§7.4 propose_consumption).
 * The session moves to awaiting_confirmation; re-proposing an identical plan returns the same
 * version without touching the session (§3.1 table, §4.1 upsert rule).
 */
export async function proposeConsumption(
  tx: Tx,
  householdId: string,
  conversationId: string,
  input: ConsumeInput,
): Promise<ProposedConsumption> {
  const session = await lockActiveSession(tx, householdId, input.session_id);
  const normalized = { session_id: session.id, overrides: input.overrides ?? [] };
  const plan = await planConsumption(tx, session, normalized.overrides);
  const subjectKey = consumeSubject(session.id);
  const draft = (stateVersion: number) => ({
    kind: 'consume' as const,
    subjectKey,
    conversationId,
    targetSessionId: session.id,
    input: normalized,
    payload: plan.payload,
    preconditions: preconditionsFor(session.id, stateVersion, plan.batches),
  });

  // Already waiting on this exact card: nothing changes, not even state_version.
  if (session.state === 'awaiting_confirmation') {
    const pending = await pendingProposal(tx, householdId, subjectKey);
    const same = draft(session.state_version);
    if (pending && canonicalJson([pending.payload, pending.preconditions]) === canonicalJson([same.payload, same.preconditions])) {
      return { ...(await upsertProposal(tx, householdId, same)), card: plan.payload.card };
    }
  }

  const { rows } = await tx.query<{ state_version: number }>(
    `UPDATE pantry.cooking_sessions SET state = 'awaiting_confirmation', state_version = state_version + 1
      WHERE id = $1 RETURNING state_version`,
    [session.id],
  );
  return { ...(await upsertProposal(tx, householdId, draft(rows[0]!.state_version))), card: plan.payload.card };
}

/** Lines from the session plan plus overrides, allocated FEFO and pinned (§6.4). */
async function planConsumption(
  tx: Tx,
  session: SessionRow,
  overrides: ReadonlyArray<{ item: string; quantity: number }>,
): Promise<{ payload: ConsumePayload; batches: BatchView[] }> {
  const householdId = session.household_id;
  const items = await itemInfo(tx, householdId);
  const nameOf = (id: string) => items.get(id)?.name ?? id;

  const need = demandByItem(session.planned_usage);
  if (overrides.length > 0) {
    const catalog = await loadCatalog(tx, householdId);
    for (const o of overrides) {
      const item = findItem(o.item, catalog);
      if (!item) throw new PantryError('unknown_item', `There is no ${o.item} in the catalog.`, { item: o.item });
      need.set(item.id, o.quantity);
    }
  }
  for (const [itemId, quantity] of need) if (quantity <= 0) need.delete(itemId);

  const today = await householdToday(tx, householdId);
  const batches = await activeBatches(tx, householdId, today, { itemIds: [...need.keys()] });
  const allocation = allocateFefo(need, batches, nameOf);
  const lines: ConsumeLine[] = [...need].map(([itemId, quantity]) => ({
    item_id: itemId,
    item: nameOf(itemId),
    unit: items.get(itemId)!.base_unit,
    quantity,
  }));
  const touched = batches.filter((b) => allocation.some((a) => a.batch_id === b.batch_id));
  return { payload: { lines, allocation, card: renderCard(lines, allocation, touched) }, batches: touched };
}

function preconditionsFor(sessionId: string, stateVersion: number, batches: readonly BatchView[]): ConsumePreconditions {
  return {
    session: { id: sessionId, state: 'awaiting_confirmation', state_version: stateVersion },
    batches: batches.map((b) => ({ id: b.batch_id, version: b.version })).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** One card line per batch, so the card shows exactly what changes (FR-17). */
function renderCard(lines: readonly ConsumeLine[], allocation: readonly AllocationLine[], batches: readonly BatchView[]): Card {
  const batchLines = allocation.map((a) => {
    const batch = batches.find((b) => b.batch_id === a.batch_id)!;
    return `${speakQuantity(batch.item, -a.delta, batch.unit, batch.unit)} · ${batch.date_label}`;
  });
  const spoken = lines.map((l) => speakQuantity(l.item, l.quantity, l.unit, l.unit));
  return {
    title: 'What you used',
    lines: batchLines,
    warnings: [],
    readback_text:
      spoken.length > 0
        ? `I'll record ${listAnd(spoken)}. ${CONFIRM_PROMPT}`
        : `There's nothing from the pantry to record. ${CONFIRM_PROMPT}`,
  };
}

/** Card edits add to earlier overrides; a later amount for the same item replaces the earlier one. */
export function mergeOverrides(
  earlier: ReadonlyArray<{ item: string; quantity: number }>,
  later: ReadonlyArray<{ item: string; quantity: number }>,
): Array<{ item: string; quantity: number }> {
  const byName = new Map<string, { item: string; quantity: number }>();
  for (const o of [...earlier, ...later]) byName.set(normalizeName(o.item), o);
  return [...byName.values()];
}
