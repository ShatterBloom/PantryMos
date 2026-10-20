// Stock adjustments (IMPLEMENTATION_PLAN §6.2, §7.4 propose_adjustment): the counted stock differs from
// the record, something was thrown out, or more was found. Which batches change is decided here.
import type { AllocationLine, BatchStock } from './allocation.ts';
import { allocateFefo } from './allocation.ts';
import { PantryError } from './errors.ts';
import { formatNumber, listOr, speakQuantity } from './speech.ts';
import type { BaseUnit } from './items.ts';
import { roundQuantity } from './units.ts';

export type AdjustReason = 'stock_check' | 'discard' | 'found_more' | 'other';

/** A batch the adjustment may touch, with what the card says about it. */
export interface AdjustBatch extends BatchStock {
  status: 'active' | 'depleted' | 'discarded';
  date_label: string;
}

export interface AdjustRequest {
  /** A specific batch, or "new" for a new batch of found stock. */
  batch_id?: string | undefined;
  delta?: number | undefined;
  set_quantity?: number | undefined;
  reason: AdjustReason;
}

export interface AdjustContext {
  item: { id: string; name: string; base_unit: BaseUnit };
  /** The item's active batches with stock, in FEFO order. */
  active: readonly AdjustBatch[];
  /** The batch named by `batch_id`, whatever its status; required when one is named. */
  named?: AdjustBatch | undefined;
}

export type AdjustPlan =
  | { kind: 'batches'; subject: string; allocation: AllocationLine[] }
  | { kind: 'new_batch'; subject: string; quantity: number };

/** Option the user picks when found stock could belong to several batches (§6.2). */
export const NEW_BATCH = 'new';

/**
 * Decides which batches change (§6.2): a named batch; for found stock the only active batch, or a
 * new batch when there is none (several → `ambiguous_batch`, with a new-batch option); for a
 * deduction FEFO across batches; `set_quantity` needs one batch, and with `batch_id: "new"` is the
 * new batch's quantity. Taking more than the stock is `would_go_negative`.
 */
export function planAdjustment(request: AdjustRequest, ctx: AdjustContext): AdjustPlan {
  const { item } = ctx;
  if ((request.delta === undefined) === (request.set_quantity === undefined)) {
    throw new PantryError('invalid_quantity', 'Give either a change (delta) or the counted quantity (set_quantity), not both.', {
      required: ['delta', 'set_quantity'],
    });
  }
  const amount = (n: number) => speakQuantity(item.name, n, item.base_unit, item.base_unit);

  if (request.set_quantity !== undefined) {
    const target = roundQuantity(request.set_quantity);
    // Rounding must not turn a tiny count into "there is none" and empty the batch.
    if (target === 0 && request.set_quantity > 0) throw new PantryError('invalid_quantity', 'The count is too small to record.');
    if (request.batch_id === NEW_BATCH) {
      if (target === 0) throw new PantryError('invalid_quantity', 'A new batch needs some stock in it.');
      return checkReason(request.reason, target, { kind: 'new_batch', subject: `adjust:newbatch:${item.id}`, quantity: target });
    }
    const batch = ctx.named ?? singleBatch(ctx, false);
    if (!batch) {
      if (target === 0) throw new PantryError('no_change', `There is no ${item.name} in stock already.`, { quantity: 0 });
      return checkReason(request.reason, target, { kind: 'new_batch', subject: `adjust:newbatch:${item.id}`, quantity: target });
    }
    const delta = roundQuantity(target - batch.quantity);
    if (delta === 0) {
      throw new PantryError('no_change', `That batch already has ${amount(target)}.`, { batch_id: batch.batch_id, quantity: target });
    }
    return checkReason(request.reason, delta, oneBatch(batch, delta));
  }

  const delta = roundQuantity(request.delta!);
  if (delta === 0) throw new PantryError('invalid_quantity', 'The change is too small to record.');
  checkReason(request.reason, delta, null);

  if (delta > 0) {
    if (request.batch_id === NEW_BATCH || (!ctx.named && ctx.active.length === 0)) {
      return { kind: 'new_batch', subject: `adjust:newbatch:${item.id}`, quantity: delta };
    }
    return oneBatch(ctx.named ?? singleBatch(ctx, true)!, delta);
  }

  if (request.batch_id === NEW_BATCH) {
    throw new PantryError('invalid_quantity', 'A new batch can only hold found stock, not take any away.');
  }
  if (ctx.named) {
    if (-delta > ctx.named.quantity) throw wouldGoNegative(item.name, -delta, ctx.named.quantity, amount);
    return oneBatch(ctx.named, delta);
  }
  const have = roundQuantity(ctx.active.reduce((sum, b) => sum + b.quantity, 0));
  if (-delta > have) throw wouldGoNegative(item.name, -delta, have, amount);
  const allocation = allocateFefo(new Map([[item.id, -delta]]), ctx.active, () => item.name);
  return {
    kind: 'batches',
    subject: allocation.length === 1 ? `adjust:batch:${allocation[0]!.batch_id}` : `adjust:item:${item.id}`,
    allocation,
  };
}

function oneBatch(batch: AdjustBatch, delta: number): AdjustPlan {
  return {
    kind: 'batches',
    subject: `adjust:batch:${batch.batch_id}`,
    allocation: [{ batch_id: batch.batch_id, item_id: batch.item_id, delta }],
  };
}

/** The item's only active batch; none → null; several → `ambiguous_batch` (with a new-batch option for found stock). */
function singleBatch(ctx: AdjustContext, offerNew: boolean): AdjustBatch | null {
  if (ctx.active.length <= 1) return ctx.active[0] ?? null;
  const options: Array<{ batch_id: string; quantity?: number; date_label: string }> = ctx.active.map((b) => ({
    batch_id: b.batch_id,
    quantity: b.quantity,
    date_label: b.date_label,
  }));
  if (offerNew) options.push({ batch_id: NEW_BATCH, date_label: 'new batch' });
  const spoken = options.map((o) => (o.batch_id === NEW_BATCH ? 'a new batch' : `the one ${o.date_label}`));
  throw new PantryError('ambiguous_batch', `There is more than one batch of ${ctx.item.name}.`, {
    ask: `Which one: ${listOr(spoken)}?`,
    options,
  });
}

/** Throwing out only removes stock; found stock only adds. */
function checkReason<T>(reason: AdjustReason, delta: number, plan: T): T {
  if (reason === 'discard' && delta > 0) {
    throw new PantryError('invalid_quantity', 'Throwing something out can only lower the stock.');
  }
  if (reason === 'found_more' && delta < 0) {
    throw new PantryError('invalid_quantity', 'Found stock can only raise the stock.');
  }
  return plan;
}

function wouldGoNegative(item: string, take: number, have: number, amount: (n: number) => string): PantryError {
  return new PantryError('would_go_negative', `Only ${amount(have)} ${have === 1 ? 'is' : 'are'} recorded, not ${formatNumber(take)}.`, {
    item,
    have,
    options: ['set the counted quantity instead'],
  });
}
