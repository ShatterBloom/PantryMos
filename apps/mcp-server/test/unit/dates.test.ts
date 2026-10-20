import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  dateLabel,
  daysBetween,
  formatShort,
  isIsoDate,
  validateBatchDates,
} from '../../src/domain/dates.ts';
import type { PantryError } from '../../src/domain/errors.ts';

const base = { purchased_at: '2026-10-08', opened_at: null, package_date: null, package_date_type: null } as const;

describe('date labels (PRD FR-7)', () => {
  it('formats short dates', () => {
    expect(formatShort('2026-10-18')).toBe('Oct 18');
    expect(formatShort('2027-01-02')).toBe('Jan 2');
  });

  it('counts calendar days across month and year boundaries', () => {
    expect(daysBetween('2026-10-08', '2026-10-13')).toBe(5);
    expect(daysBetween('2026-12-30', '2027-01-02')).toBe(3);
  });

  it('labels package dates with their source', () => {
    expect(dateLabel({ ...base, package_date: '2026-10-18', package_date_type: 'use_by' }, '2026-10-13')).toBe(
      'use by Oct 18 (from package)',
    );
    expect(dateLabel({ ...base, package_date: '2026-10-18', package_date_type: 'best_by' }, '2026-10-13')).toBe(
      'best by Oct 18 (from package)',
    );
    expect(dateLabel({ ...base, package_date: '2026-10-18', package_date_type: 'unknown' }, '2026-10-13')).toBe(
      'dated Oct 18 on package',
    );
  });

  it('never invents an expiry date without a package date', () => {
    expect(dateLabel(base, '2026-10-13')).toBe('stored for 5 days, no package date');
    expect(dateLabel(base, '2026-10-09')).toBe('stored for 1 day, no package date');
    expect(dateLabel(base, '2026-10-08')).toBe('bought today, no package date');
  });

  it('appends the opened date', () => {
    expect(dateLabel({ ...base, opened_at: '2026-10-12' }, '2026-10-13')).toBe(
      'stored for 5 days, no package date, opened Oct 12',
    );
  });
});

describe('isIsoDate', () => {
  it('accepts real calendar dates', () => {
    expect(isIsoDate('2026-10-18')).toBe(true);
    expect(isIsoDate('2028-02-29')).toBe(true);
  });

  it.each(['2026-02-30', '2027-02-29', '2026-13-01', '2026-00-10', '2026-10-1', '26-10-18', '2026/10/18', '', 'today'])(
    'rejects %j',
    (value) => {
      expect(isIsoDate(value)).toBe(false);
    },
  );
});

describe('addDays', () => {
  it('crosses month, year and leap-day boundaries', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('property: daysBetween(d, addDays(d, n)) = n', () => {
    const date = fc.date({ min: new Date('2000-01-01'), max: new Date('2100-01-01'), noInvalidDate: true });
    fc.assert(
      fc.property(date, fc.integer({ min: -3000, max: 3000 }), (d, n) => {
        const iso = d.toISOString().slice(0, 10);
        expect(daysBetween(iso, addDays(iso, n))).toBe(n);
        expect(isIsoDate(addDays(iso, n))).toBe(true);
      }),
    );
  });

  it('throws on malformed input instead of producing a wrong date', () => {
    expect(() => addDays('2026-02-30', 1)).toThrow(/Not an ISO date/);
  });
});

describe('validateBatchDates (§2.4)', () => {
  const today = '2026-10-20';
  type Dates = Parameters<typeof validateBatchDates>[0];
  const ok: Dates = { purchased_at: today, opened_at: null, package_date: null };
  const failure = (dates: Partial<Dates>) => {
    try {
      validateBatchDates({ ...ok, ...dates }, today, 'items[2]');
    } catch (err) {
      const e = err as PantryError;
      return { code: e.code, field: e.details.field };
    }
    return null;
  };

  it('accepts a typical batch', () => {
    expect(failure({ purchased_at: '2026-10-19', opened_at: '2026-10-20', package_date: '2026-10-25' })).toBeNull();
  });

  it('accepts the boundary values', () => {
    expect(failure({ purchased_at: addDays(today, -365) })).toBeNull();
    expect(failure({ package_date: addDays(today, 730) })).toBeNull();
    expect(failure({ package_date: addDays(today, -730) })).toBeNull();
  });

  it('rejects malformed dates and names the field', () => {
    expect(failure({ purchased_at: '2026-02-30' })).toEqual({ code: 'invalid_date', field: 'items[2].purchased_at' });
    expect(failure({ package_date: 'soon' })).toEqual({ code: 'invalid_date', field: 'items[2].package_date' });
  });

  it('rejects a purchase date in the future or older than a year', () => {
    expect(failure({ purchased_at: '2026-10-21' })?.field).toBe('items[2].purchased_at');
    expect(failure({ purchased_at: addDays(today, -366) })?.field).toBe('items[2].purchased_at');
  });

  it('rejects an opened date before purchase or in the future', () => {
    expect(failure({ purchased_at: '2026-10-15', opened_at: '2026-10-14' })?.field).toBe('items[2].opened_at');
    expect(failure({ purchased_at: '2026-10-15', opened_at: '2026-10-21' })?.field).toBe('items[2].opened_at');
  });

  it('rejects a package date more than two years away', () => {
    expect(failure({ package_date: addDays(today, 731) })?.field).toBe('items[2].package_date');
    expect(failure({ package_date: addDays(today, -731) })?.field).toBe('items[2].package_date');
  });
});
