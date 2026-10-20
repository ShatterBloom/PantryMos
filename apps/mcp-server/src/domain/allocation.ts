// Batch allocation (IMPLEMENTATION_PLAN §6.2): which batches a deduction takes from.
import { PantryError } from './errors.ts';
import { formatNumber } from './speech.ts';
import { roundQuantity as round } from './units.ts';

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

/** A batch a session took from, and how much of it the session still holds (net of returns and undo). */
export interface SourceBatch {
  batch_id: string;
  item_id: string;
  taken: number;
}

/**
 * Returns each item's quantity to the batches the session took it from (§6.2): `sources` must be in
 * return order (most recent net consumption first); each gets back at most what it gave. Asking to
 * return more than the session holds is a caller bug, since the revision diff is computed from the
 * same events.
 */
export function allocateReturn(give: ReadonlyMap<string, number>, sources: readonly SourceBatch[]): AllocationLine[] {
  const lines: AllocationLine[] = [];
  for (const [itemId, wanted] of give) {
    let remaining = wanted;
    for (const source of sources) {
      if (remaining <= 0) break;
      if (source.item_id !== itemId || source.taken <= 0) continue;
      const back = round(Math.min(source.taken, remaining));
      lines.push({ batch_id: source.batch_id, item_id: itemId, delta: back });
      remaining = round(remaining - back);
    }
    if (remaining > 0) throw new Error(`Session holds less ${itemId} than the ${wanted} to return`);
  }
  return lines;
}
