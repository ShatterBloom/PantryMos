// Date helpers. All dates are ISO 'YYYY-MM-DD' strings in household time (IMPLEMENTATION_PLAN §2.4, §6.1).
import { PantryError } from './errors.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export type PackageDateType = 'use_by' | 'best_by' | 'unknown';

export interface BatchDates {
  purchased_at: string;
  opened_at: string | null;
  package_date: string | null;
  package_date_type: PackageDateType | null;
}

const DAY_MS = 86_400_000;

function tryParts(iso: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  // Reject dates that roll over, such as 2026-02-30.
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? [y, mo, d] : null;
}

function parts(iso: string): [number, number, number] {
  const p = tryParts(iso);
  if (!p) throw new Error(`Not an ISO date: ${iso}`);
  return p;
}

/** True for a real calendar date written as 'YYYY-MM-DD'. */
export function isIsoDate(value: string): boolean {
  return tryParts(value) !== null;
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = parts(iso);
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
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
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / DAY_MS);
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

/** Purchase dates may go back one year (§2.4). */
export const MAX_PURCHASE_AGE_DAYS = 365;
/** Package dates must be within two years of today, either way (§2.4). */
export const MAX_PACKAGE_DISTANCE_DAYS = 730;

/**
 * Validates one batch's dates against household `today` (§2.4).
 * `path` names the input line in errors, e.g. "items[0]".
 */
export function validateBatchDates(
  dates: { purchased_at: string; opened_at: string | null; package_date: string | null },
  today: string,
  path: string,
): void {
  const fail = (field: string, message: string) => {
    throw new PantryError('invalid_date', message, { field: `${path}.${field}` });
  };
  for (const field of ['purchased_at', 'opened_at', 'package_date'] as const) {
    const value = dates[field];
    if (value !== null && !isIsoDate(value)) fail(field, `${value} is not a valid YYYY-MM-DD date.`);
  }
  const age = daysBetween(dates.purchased_at, today);
  if (age < 0) fail('purchased_at', 'The purchase date cannot be in the future.');
  if (age > MAX_PURCHASE_AGE_DAYS) fail('purchased_at', 'The purchase date must be within the last year.');
  if (dates.opened_at !== null) {
    if (daysBetween(dates.purchased_at, dates.opened_at) < 0) {
      fail('opened_at', 'The opened date cannot be before the purchase date.');
    }
    if (daysBetween(dates.opened_at, today) < 0) fail('opened_at', 'The opened date cannot be in the future.');
  }
  if (dates.package_date !== null && Math.abs(daysBetween(today, dates.package_date)) > MAX_PACKAGE_DISTANCE_DAYS) {
    fail('package_date', 'The package date must be within two years of today.');
  }
}
