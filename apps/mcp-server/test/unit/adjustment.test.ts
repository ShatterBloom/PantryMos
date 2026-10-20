import { describe, expect, it } from 'vitest';
import { type AdjustBatch, type AdjustContext, type AdjustRequest, NEW_BATCH, planAdjustment } from '../../src/domain/adjustment.ts';
import type { PantryError } from '../../src/domain/errors.ts';

const egg = { id: 'egg', name: 'egg', base_unit: 'count' as const };
const batch = (batch_id: string, quantity: number, status: AdjustBatch['status'] = 'active'): AdjustBatch => ({
  batch_id,
  item_id: 'egg',
  quantity,
  version: 1,
  status,
  date_label: `label ${batch_id}`,
});
// FEFO order: A before B.
const A = batch('A', 4);
const B = batch('B', 12);
const ctx = (active: AdjustBatch[], named?: AdjustBatch): AdjustContext => ({ item: egg, active, named });
const plan = (request: Partial<AdjustRequest>, c: AdjustContext) => planAdjustment({ reason: 'other', ...request }, c);
const error = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err as PantryError;
  }
  throw new Error('expected a PantryError');
};

describe('planAdjustment (§6.2)', () => {
  describe('found stock (positive)', () => {
    it('goes to the named batch, or to the only active batch', () => {
      expect(plan({ delta: 2, batch_id: 'B' }, ctx([A, B], B))).toEqual({
        kind: 'batches',
        subject: 'adjust:batch:B',
        allocation: [{ batch_id: 'B', item_id: 'egg', delta: 2 }],
      });
      expect(plan({ delta: 2, reason: 'found_more' }, ctx([A]))).toMatchObject({ subject: 'adjust:batch:A' });
    });

    it('asks which batch when there are several, offering a new batch (R26)', () => {
      const err = error(() => plan({ delta: 2 }, ctx([A, B])));
      expect(err.code).toBe('ambiguous_batch');
      expect(err.details).toEqual({
        ask: 'Which one: the one label A, the one label B or a new batch?',
        options: [
          { batch_id: 'A', quantity: 4, date_label: 'label A' },
          { batch_id: 'B', quantity: 12, date_label: 'label B' },
          { batch_id: 'new', date_label: 'new batch' },
        ],
      });
    });

    it('makes a new batch when asked, or when there is no active batch', () => {
      const newBatch = { kind: 'new_batch', subject: 'adjust:newbatch:egg', quantity: 6 };
      expect(plan({ delta: 6, batch_id: 'new' }, ctx([A, B]))).toEqual(newBatch);
      expect(plan({ delta: 6 }, ctx([]))).toEqual(newBatch);
    });

    it('can refill a depleted batch the user names', () => {
      const empty = batch('E', 0, 'depleted');
      expect(plan({ delta: 1, batch_id: 'E' }, ctx([A], empty))).toMatchObject({ allocation: [{ batch_id: 'E', delta: 1 }] });
    });
  });

  describe('removed stock (negative)', () => {
    it('takes FEFO across batches, keyed by item when it spans several', () => {
      expect(plan({ delta: -6, reason: 'discard' }, ctx([A, B]))).toEqual({
        kind: 'batches',
        subject: 'adjust:item:egg',
        allocation: [
          { batch_id: 'A', item_id: 'egg', delta: -4 },
          { batch_id: 'B', item_id: 'egg', delta: -2 },
        ],
      });
      expect(plan({ delta: -3 }, ctx([A, B]))).toMatchObject({ subject: 'adjust:batch:A' });
    });

    it('takes only from the named batch', () => {
      expect(plan({ delta: -3, batch_id: 'B' }, ctx([A, B], B))).toMatchObject({ allocation: [{ batch_id: 'B', delta: -3 }] });
    });

    it('refuses to take more than is recorded (would_go_negative)', () => {
      expect(error(() => plan({ delta: -5, batch_id: 'A' }, ctx([A, B], A)))).toMatchObject({
        code: 'would_go_negative',
        message: 'Only 4 eggs are recorded, not 5.',
      });
      expect(error(() => plan({ delta: -17 }, ctx([A, B]))).details).toMatchObject({ item: 'egg', have: 16 });
      expect(error(() => plan({ delta: -1 }, ctx([]))).message).toBe('Only 0 eggs are recorded, not 1.');
      expect(error(() => plan({ delta: -2 }, ctx([batch('C', 1)]))).message).toBe('Only 1 egg is recorded, not 2.');
    });

    it('never takes from a new batch', () => {
      expect(error(() => plan({ delta: -1, batch_id: 'new' }, ctx([A]))).code).toBe('invalid_quantity');
    });
  });

  describe('counted quantity (set_quantity)', () => {
    it('sets one batch to the count, as a pinned delta', () => {
      expect(plan({ set_quantity: 1, reason: 'stock_check' }, ctx([A]))).toEqual({
        kind: 'batches',
        subject: 'adjust:batch:A',
        allocation: [{ batch_id: 'A', item_id: 'egg', delta: -3 }],
      });
      expect(plan({ set_quantity: 15, batch_id: 'B' }, ctx([A, B], B))).toMatchObject({ allocation: [{ batch_id: 'B', delta: 3 }] });
    });

    it('needs one batch: asks among several, without a new-batch option', () => {
      const err = error(() => plan({ set_quantity: 3 }, ctx([A, B])));
      expect(err.code).toBe('ambiguous_batch');
      expect((err.details.options as Array<{ batch_id: string }>).map((o) => o.batch_id)).toEqual(['A', 'B']);
    });

    it('records a count for an item with no stock as a new batch', () => {
      expect(plan({ set_quantity: 2 }, ctx([]))).toEqual({ kind: 'new_batch', subject: 'adjust:newbatch:egg', quantity: 2 });
      expect(error(() => plan({ set_quantity: 0 }, ctx([])))).toMatchObject({ code: 'no_change', details: { quantity: 0 } });
    });

    it('refuses a positive count that rounds to nothing instead of emptying the batch', () => {
      const err = error(() => plan({ set_quantity: 0.0001 }, ctx([A])));
      expect(err).toMatchObject({ code: 'invalid_quantity', message: 'The count is too small to record.' });
    });

    it('puts a count for batch "new" in a new batch, leaving the existing ones alone', () => {
      expect(plan({ set_quantity: 2, batch_id: NEW_BATCH }, ctx([A]))).toEqual({
        kind: 'new_batch',
        subject: 'adjust:newbatch:egg',
        quantity: 2,
      });
      expect(error(() => plan({ set_quantity: 0, batch_id: NEW_BATCH }, ctx([A]))).code).toBe('invalid_quantity');
      expect(error(() => plan({ set_quantity: 2, batch_id: NEW_BATCH, reason: 'discard' }, ctx([A]))).code).toBe('invalid_quantity');
    });

    it('says when the count already matches', () => {
      expect(error(() => plan({ set_quantity: 4 }, ctx([A])))).toMatchObject({
        code: 'no_change',
        message: 'That batch already has 4 eggs.',
        details: { batch_id: 'A', quantity: 4 },
      });
    });
  });

  it('needs exactly one of delta and set_quantity, and a change it can record', () => {
    expect(error(() => plan({}, ctx([A]))).code).toBe('invalid_quantity');
    expect(error(() => plan({ delta: 1, set_quantity: 1 }, ctx([A]))).details).toEqual({ required: ['delta', 'set_quantity'] });
    expect(error(() => plan({ delta: 0.0001 }, ctx([A]))).message).toBe('The change is too small to record.');
  });

  it('keeps the reason honest: a discard only lowers stock, found stock only raises it', () => {
    expect(error(() => plan({ delta: 1, reason: 'discard' }, ctx([A]))).code).toBe('invalid_quantity');
    expect(error(() => plan({ set_quantity: 5, reason: 'discard' }, ctx([A]))).code).toBe('invalid_quantity');
    expect(error(() => plan({ delta: -1, reason: 'found_more' }, ctx([A]))).code).toBe('invalid_quantity');
  });
});
