// Date helpers. All dates are ISO 'YYYY-MM-DD' strings in household time (IMPLEMENTATION_PLAN §2.4, §6.1).

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export type PackageDateType = 'use_by' | 'best_by' | 'unknown';

export interface BatchDates {
  purchased_at: string;
  opened_at: string | null;
  package_date: string | null;
  package_date_type: PackageDateType | null;
}

function parts(iso: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`Not an ISO date: ${iso}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** 'Oct 18' */
export function formatShort(iso: string): string {
  const [, month, day] = parts(iso);
  return `${MONTHS[month - 1]} ${day}`;
}

/** Whole days from `from` to `to` (calendar dates, timezone-free). */
export function daysBetween(from: string, to: string): number {
  const [y1, m1, d1] = parts(from);
  const [y2, m2, d2] = parts(to);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

/** Server-generated label the model must relay verbatim (PRD FR-7). */
export function dateLabel(batch: BatchDates, today: string): string {
  let label: string;
  if (batch.package_date !== null) {
    const date = formatShort(batch.package_date);
    switch (batch.package_date_type) {
      case 'use_by':
        label = `use by ${date} (from package)`;
        break;
      case 'best_by':
        label = `best by ${date} (from package)`;
        break;
      default:
        label = `dated ${date} on package`;
    }
  } else {
    const days = daysBetween(batch.purchased_at, today);
    label =
      days <= 0
        ? 'bought today, no package date'
        : `stored for ${days} ${days === 1 ? 'day' : 'days'}, no package date`;
  }
  if (batch.opened_at !== null) label += `, opened ${formatShort(batch.opened_at)}`;
  return label;
}
