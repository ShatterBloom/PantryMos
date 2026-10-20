import { describe, expect, it } from 'vitest';
import { staleReasonOf } from '../../src/commit/confirm.ts';

describe('staleReasonOf (§4.3 step 3)', () => {
  it('maps a unique constraint a concurrent commit could hit to its stale reason', () => {
    expect(staleReasonOf({ code: '23505', constraint: 'items_name_ci' })).toBe('catalog_changed');
    expect(staleReasonOf({ code: '23505', constraint: 'unit_conversions_pkey' })).toBe('catalog_changed');
    expect(staleReasonOf({ code: '23505', constraint: 'one_revert_per_event' })).toBe('already_reverted');
  });

  it('leaves every other error a fault', () => {
    expect(staleReasonOf({ code: '23514', constraint: 'batches_quantity_check' })).toBeNull();
    expect(staleReasonOf(new Error('connection lost'))).toBeNull();
    expect(staleReasonOf(null)).toBeNull();
  });
});
