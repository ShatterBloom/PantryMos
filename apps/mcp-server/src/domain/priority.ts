// Priority date (IMPLEMENTATION_PLAN §6.1): what "use first" ordering is based on.
import { addDays } from './dates.ts';

/** Shelf life assumed when neither the package nor the catalog gives one. */
export const DEFAULT_ESTIMATE_DAYS = 7;

export interface Priority {
  priority_date: string;
  priority_source: 'package' | 'estimate';
}

/** Package date if known; else purchase date + the item's shelf days; else purchase date + 7. */
export function priorityOf(
  batch: { purchased_at: string; package_date: string | null },
  defaultShelfDays: number | null,
): Priority {
  if (batch.package_date !== null) return { priority_date: batch.package_date, priority_source: 'package' };
  return {
    priority_date: addDays(batch.purchased_at, defaultShelfDays ?? DEFAULT_ESTIMATE_DAYS),
    priority_source: 'estimate',
  };
}
