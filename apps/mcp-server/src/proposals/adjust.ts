// Stock adjustment proposals (IMPLEMENTATION_PLAN §4.2, §6.2, §7.4 propose_adjustment).
import { z } from 'zod';
import { householdToday, loadCatalog } from '../db/catalog.ts';
import { activeBatches, batchesByIds, type BatchView } from '../db/inventory.ts';
import { type ProposalRef, upsertProposal } from '../db/proposals.ts';
import { availableByItem, findSession } from '../db/sessions.ts';
import type { Tx } from '../db/tx.ts';
import { type AdjustReason, NEW_BATCH, planAdjustment } from '../domain/adjustment.ts';
import type { AllocationLine } from '../domain/allocation.ts';
import { type Card, CONFIRM_PROMPT } from '../domain/card.ts';
import { demandByItem } from '../domain/cooking.ts';
import { dateLabel } from '../domain/dates.ts';
import { PantryError } from '../domain/errors.ts';
import { MAX_QUANTITY } from '../domain/intake.ts';
import { type BaseUnit, type CatalogItem, findItem } from '../domain/items.ts';
import { type Priority, priorityOf } from '../domain/priority.ts';
import { speakQuantity } from '../domain/speech.ts';
import { roundQuantity } from '../domain/units.ts';
import { NameInput } from '../mcp/schemas.ts';

export const ADJUST_REASONS = ['stock_check', 'discard', 'found_more', 'other'] as const;

/** Tool input (§7.4); exactly one of delta and set_quantity is checked by the planner. */
export const AdjustInputShape = {
  item: NameInput.optional().describe('The item, e.g. "eggs". Optional when batch_id is given.'),
  batch_id: z
    .union([z.uuid(), z.literal(NEW_BATCH)])
    .optional()
    .describe('A batch from list_inventory, or "new" for found stock that is a separate batch.'),
  delta: z
    .number()
    .min(-MAX_QUANTITY)
    .max(MAX_QUANTITY)
    .optional()
    .describe('Change in base units: negative removes, positive adds. E.g. -2 for two eggs thrown out.'),
  set_quantity: z.number().min(0).max(MAX_QUANTITY).optional().describe('The counted quantity of one batch, in base units.'),
  share: z
    .object({
      fraction: z.number().gt(0).max(1).describe('The part named: 1, 0.5, 1/3, 2/3, 0.25 or 0.75 (all, half, a third, two thirds, a quarter, three quarters).'),
      of: z.enum(['stock', 'recipe']).describe('"stock": of all the item in stock; "recipe": of what the meal being cooked uses.'),
    })
    .optional()
    .describe(
      'Instead of delta, only when the user names a share ("I spilled half the milk"); an amount the user said ("200 ml") is a delta. The server works out the amount and the card says how, so the user can correct it.',
    ),
  reason: z.enum(ADJUST_REASONS),
  note: z
    .string()
    .trim()
    .max(200)
    .regex(/^[^\p{Cc}]*$/u, 'must not contain control characters')
    .optional(),
};
export const AdjustInput = z.object(AdjustInputShape);
export type AdjustInput = z.infer<typeof AdjustInput>;

export interface NewBatch extends Priority {
  item_id: string;
  quantity: number;
  purchased_at: string;
}

export interface AdjustPayload {
  item_id: string;
  item: string;
  unit: BaseUnit;
  reason: AdjustReason;
  note: string | null;
  /**
   * The counted quantity the one changed batch is set to, or null for a change by delta. The batch
   * is pinned, so it is also the batch's quantity once this commits.
   */
  set_quantity: number | null;
  allocation: AllocationLine[];
  new_batch: NewBatch | null;
  card: Card;
}

export interface AdjustPreconditions {
  batches: Array<{ id: string; version: number }>;
}

export interface SessionImpact {
  item: string;
  planned: number;
  available_after: number;
  short: number;
}

/**
 * Proposes a stock change (§7.4 propose_adjustment): which batches change is pinned now, and the
 * card is confirmed like any other. Also reports how the change affects the meal being cooked.
 */
export async function proposeAdjustment(
  tx: Tx,
  householdId: string,
  conversationId: string,
  input: AdjustInput,
): Promise<ProposalRef & { card: Card; impact_on_active_session: SessionImpact[] }> {
  const catalog = await loadCatalog(tx, householdId);
  const today = await householdToday(tx, householdId);
  const named = input.batch_id && input.batch_id !== NEW_BATCH ? await namedBatch(tx, householdId, input.batch_id, today) : undefined;
  const item = resolveTarget(input, catalog, named);
  const active = await activeBatches(tx, householdId, today, { itemIds: [item.id] });

  const share = input.share ? await resolveShare(tx, householdId, input, item, active, named) : null;
  const plan = planAdjustment(share ? { ...input, delta: -share.amount } : input, { item, active, named });
  const allocation = plan.kind === 'batches' ? plan.allocation : [];
  const new_batch =
    plan.kind === 'new_batch'
      ? { item_id: item.id, quantity: plan.quantity, purchased_at: today, ...priorityOf({ purchased_at: today, package_date: null }, item.default_shelf_days) }
      : null;
  const touched = await batchesByIds(tx, householdId, allocation.map((a) => a.batch_id), today);
  const payload: AdjustPayload = {
    item_id: item.id,
    item: item.name,
    unit: item.base_unit,
    reason: input.reason,
    note: input.note ?? null,
    set_quantity: input.set_quantity === undefined ? null : roundQuantity(input.set_quantity),
    allocation,
    new_batch,
    card: renderCard(item, input.reason, allocation, touched, new_batch, today, share?.basis ?? null),
  };
  const impact = await sessionImpact(tx, householdId, item, allocation, new_batch);
  const short = impact.find((i) => i.short > 0)?.short;
  if (short !== undefined) {
    // Said by the app, from these numbers: the model's own account got them wrong (eval P10).
    const amount = speakQuantity(item.name, short, item.base_unit, item.base_unit);
    payload.card.warnings.push(`The meal being cooked would be ${amount} short.`);
    payload.card.readback_text = payload.card.readback_text.replace(
      CONFIRM_PROMPT,
      `That leaves the meal ${amount} short: you can carry on with less, use a substitute, add ${item.name} to the shopping list, ` +
        `or cook it another time. ${CONFIRM_PROMPT}`,
    );
  }

  const preconditions: AdjustPreconditions = {
    batches: touched.map((b) => ({ id: b.batch_id, version: b.version })),
  };
  const ref = await upsertProposal(tx, householdId, {
    kind: 'adjust',
    subjectKey: plan.subject,
    conversationId,
    input,
    payload,
    preconditions,
  });
  return { ...ref, card: payload.card, impact_on_active_session: impact };
}

async function namedBatch(tx: Tx, householdId: string, batchId: string, today: string): Promise<BatchView> {
  const [batch] = await batchesByIds(tx, householdId, [batchId], today);
  if (!batch) throw new PantryError('not_found', 'There is no such batch.', { batch_id: batchId });
  return batch;
}

/** The item from `item`, from the named batch, or both when they agree. */
function resolveTarget(input: AdjustInput, catalog: readonly CatalogItem[], named: BatchView | undefined): CatalogItem {
  if (input.item === undefined) {
    if (!named) throw new PantryError('needs_clarification', 'Which item is it?', { ask: 'Which item should I adjust?', required: ['item'] });
    return catalog.find((i) => i.id === named.item_id)!;
  }
  const item = findItem(input.item, catalog);
  if (!item) throw new PantryError('unknown_item', `There is no ${input.item} in the catalog.`, { item: input.item });
  if (named && named.item_id !== item.id) {
    throw new PantryError('not_found', `That batch is ${named.item}, not ${item.name}.`, { batch_id: named.batch_id });
  }
  return item;
}

/** A share the user named, as an amount in base units and how it was worked out ("half of the 1000 milliliters you had"). */
async function resolveShare(
  tx: Tx,
  householdId: string,
  input: AdjustInput,
  item: CatalogItem,
  active: readonly { quantity: number }[],
  named: BatchView | undefined,
): Promise<{ amount: number; basis: string }> {
  const { fraction, of } = input.share!;
  // A share is a part people name; 0.2 is the model turning "200 ml" of a litre into one (eval P4).
  const words = shareWords(fraction);
  if (words === undefined) {
    throw new PantryError('invalid_quantity', 'A share is a part the user named, like half or a third. Give an amount the user said as delta.', {
      required: ['delta'],
    });
  }
  if (input.delta !== undefined || input.set_quantity !== undefined) {
    throw new PantryError('invalid_quantity', 'Give a share, a change (delta) or a counted quantity, only one of them.', {
      required: ['share', 'delta', 'set_quantity'],
    });
  }
  if (input.reason === 'found_more') throw new PantryError('invalid_quantity', 'A share is for stock that is gone; give found stock as a delta.');

  let whole: number;
  if (of === 'stock') {
    whole = named ? named.quantity : roundQuantity(active.reduce((sum, b) => sum + b.quantity, 0));
    if (whole === 0) throw new PantryError('no_change', `There is no ${item.name} in stock.`, { quantity: 0 });
  } else {
    const session = await findSession(tx, householdId);
    const cooking = session && (session.state === 'cooking' || session.state === 'awaiting_confirmation');
    const planned = cooking ? demandByItem(session.planned_usage).get(item.id) : undefined;
    if (planned === undefined) {
      throw new PantryError('needs_clarification', `The meal being cooked does not use ${item.name}.`, {
        ask: `How much ${item.name} was it?`,
        required: ['delta'],
      });
    }
    whole = planned;
  }
  // Counted items go whole: half of 3 eggs is 2, and the card says so.
  const amount = item.base_unit === 'count' ? Math.round(fraction * whole) : roundQuantity(fraction * whole);
  if (amount === 0) throw new PantryError('invalid_quantity', `That is less than one ${item.name}.`, { ask: `How much ${item.name} was it?` });
  const ofWhat = speakQuantity(item.name, whole, item.base_unit, item.base_unit);
  return { amount, basis: `${words} of the ${ofWhat} ${of === 'stock' ? 'you had' : 'the recipe uses'}` };
}

const SHARE_WORDS: ReadonlyArray<[number, string]> = [
  [1, 'all'],
  [0.5, 'half'],
  [0.25, 'a quarter'],
  [0.75, 'three quarters'],
  [1 / 3, 'a third'],
  [2 / 3, 'two thirds'],
];

/** The words for a share people name ("half", "a third"), or undefined for any other fraction. */
function shareWords(fraction: number): string | undefined {
  return SHARE_WORDS.find(([f]) => Math.abs(f - fraction) < 0.005)?.[1];
}

/** §7.4: for the active session's plan, what this item's stock would be after the change. */
async function sessionImpact(
  tx: Tx,
  householdId: string,
  item: CatalogItem,
  allocation: readonly AllocationLine[],
  newBatch: NewBatch | null,
): Promise<SessionImpact[]> {
  const session = await findSession(tx, householdId);
  if (!session || (session.state !== 'cooking' && session.state !== 'awaiting_confirmation')) return [];
  const planned = demandByItem(session.planned_usage).get(item.id);
  if (planned === undefined) return [];
  const change = allocation.reduce((sum, a) => sum + a.delta, 0) + (newBatch?.quantity ?? 0);
  const availableAfter = roundQuantity(((await availableByItem(tx, householdId)).get(item.id) ?? 0) + change);
  return [{ item: item.name, planned, available_after: availableAfter, short: Math.max(0, roundQuantity(planned - availableAfter)) }];
}

function renderCard(
  item: CatalogItem,
  reason: AdjustReason,
  allocation: readonly AllocationLine[],
  batches: readonly BatchView[],
  newBatch: NewBatch | null,
  today: string,
  /** How a share became the amount; said so the user can correct it. */
  basis: string | null,
): Card {
  const amount = (n: number) => speakQuantity(item.name, n, item.base_unit, item.base_unit);
  const lines = allocation.map((a) => {
    const batch = batches.find((b) => b.batch_id === a.batch_id)!;
    return `${a.delta < 0 ? '−' : '+'}${amount(Math.abs(a.delta))} · ${batch.date_label}`;
  });
  if (newBatch) {
    const label = dateLabel({ purchased_at: newBatch.purchased_at, opened_at: null, package_date: null, package_date_type: null }, today);
    lines.push(`+${amount(newBatch.quantity)} · new batch, ${label}`);
  }
  const net = allocation.reduce((sum, a) => sum + a.delta, 0) + (newBatch?.quantity ?? 0);
  const change =
    reason === 'discard'
      ? `I'll record that ${amount(-net)} ${-net === 1 ? 'was' : 'were'} thrown out`
      : net < 0
        ? `I'll take ${amount(-net)} off the stock`
        : `I'll add ${amount(net)} to the stock${newBatch ? ' as a new batch' : ''}`;
  const said = `${change}${basis ? `: ${basis}` : ''}.`;
  return {
    title: reason === 'discard' ? `Throw out ${item.name}` : `Adjust ${item.name}`,
    lines,
    warnings: [],
    readback_text: `${said} ${CONFIRM_PROMPT}`,
  };
}
