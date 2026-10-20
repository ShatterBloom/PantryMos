// Usage revision (IMPLEMENTATION_PLAN §6.5): new totals for the listed items of a finished meal.
import { roundQuantity } from './units.ts';

export interface RevisionLine {
  item_id: string;
  /** Effective usage now (I5). */
  current: number;
  target: number;
  /** target − current: positive takes more from stock, negative returns some. */
  diff: number;
  status: 'changed' | 'unchanged';
}

/**
 * Every item of the session, plus listed items it did not use: listed ones get their new total,
 * the others stay as they are.
 */
export function revisionLines(current: ReadonlyMap<string, number>, targets: ReadonlyMap<string, number>): RevisionLine[] {
  const itemIds = [...new Set([...current.keys(), ...targets.keys()])];
  return itemIds
    .map((itemId) => {
      const now = current.get(itemId) ?? 0;
      const target = targets.get(itemId) ?? now;
      const diff = roundQuantity(target - now);
      return { item_id: itemId, current: now, target, diff, status: diff === 0 ? ('unchanged' as const) : ('changed' as const) };
    })
    // A listed item the session never used, set to 0, is not part of the meal.
    .filter((l) => !(l.current === 0 && l.target === 0));
}
