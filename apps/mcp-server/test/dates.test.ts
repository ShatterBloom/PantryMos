import { describe, expect, it } from 'vitest';
import { dateLabel, daysBetween, formatShort } from '../src/domain/dates.ts';

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
