import { describe, expect, it } from 'vitest';
import { DEFAULT_ESTIMATE_DAYS, priorityOf } from '../../src/domain/priority.ts';

describe('priorityOf (§6.1)', () => {
  it('uses the package date when there is one, regardless of shelf days', () => {
    expect(priorityOf({ purchased_at: '2026-10-10', package_date: '2026-10-18' }, 3)).toEqual({
      priority_date: '2026-10-18',
      priority_source: 'package',
    });
  });

  it("estimates from the item's shelf days", () => {
    expect(priorityOf({ purchased_at: '2026-10-10', package_date: null }, 5)).toEqual({
      priority_date: '2026-10-15',
      priority_source: 'estimate',
    });
  });

  it('falls back to seven days', () => {
    expect(DEFAULT_ESTIMATE_DAYS).toBe(7);
    expect(priorityOf({ purchased_at: '2026-12-28', package_date: null }, null)).toEqual({
      priority_date: '2027-01-04',
      priority_source: 'estimate',
    });
  });
});
