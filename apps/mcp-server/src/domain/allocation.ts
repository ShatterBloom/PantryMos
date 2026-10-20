// Batch allocation (IMPLEMENTATION_PLAN §6.2): which batches a deduction takes from.
import { PantryError } from './errors.ts';
import { formatNumber } from './speech.ts';

export interface BatchStock {
  batch_id: string;
  item_id: string;
  quantity: number;
  version: number;
}

/** One pinned change to one batch; deductions are negative. */
export interface AllocationLine {
  batch_id: string;
  item_id: string;
  delta: number;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Deducts each item's quantity from its batches first-expired-first-out. `batches` must already be
 * in FEFO order (priority_date, purchased_at, id). Throws `insufficient_stock` naming the first short item.
 */
export function allocateFefo(
  need: ReadonlyMap<string, number>,
  batches: readonly BatchStock[],
  nameOf: (itemId: string) => string,
): AllocationLine[] {
  const lines: AllocationLine[] = [];
  for (const [itemId, wanted] of need) {
    let remaining = wanted;
    for (const batch of batches) {
      if (remaining <= 0) break;
      if (batch.item_id !== itemId || batch.quantity <= 0) continue;
      const take = round(Math.min(batch.quantity, remaining));
      lines.push({ batch_id: batch.batch_id, item_id: itemId, delta: -take });
      remaining = round(remaining - take);
    }
    if (remaining > 0) {
      const have = round(wanted - remaining);
      throw new PantryError(
        'insufficient_stock',
        `Only ${formatNumber(have)} of the ${formatNumber(wanted)} ${nameOf(itemId)} needed is in stock.`,
        { item: nameOf(itemId), need: wanted, have },
      );
    }
  }
  return lines;
}
