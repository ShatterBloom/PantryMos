import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { allocateFefo, type BatchStock } from '../../src/domain/allocation.ts';
import type { PantryError } from '../../src/domain/errors.ts';

const batch = (batch_id: string, item_id: string, quantity: number): BatchStock => ({ batch_id, item_id, quantity, version: 1 });
const name = (id: string) => id;

describe('allocateFefo (§6.2)', () => {
  it('takes from batches in the given FEFO order, splitting across batches (R1)', () => {
    // Milk A best by 10/12 (1000 ml), B best by 10/18 (1000 ml); consume 1200 ml.
    const batches = [batch('A', 'milk', 1000), batch('B', 'milk', 1000)];
    expect(allocateFefo(new Map([['milk', 1200]]), batches, name)).toEqual([
      { batch_id: 'A', item_id: 'milk', delta: -1000 },
      { batch_id: 'B', item_id: 'milk', delta: -200 },
    ]);
  });

  it('touches only the first batch when it covers the need', () => {
    expect(allocateFefo(new Map([['egg', 2]]), [batch('A', 'egg', 6), batch('B', 'egg', 12)], name)).toEqual([
      { batch_id: 'A', item_id: 'egg', delta: -2 },
    ]);
  });

  it('allocates several items independently and skips empty batches', () => {
    const batches = [batch('E0', 'egg', 0), batch('E1', 'egg', 3), batch('T1', 'tomato', 2)];
    expect(allocateFefo(new Map([['egg', 2], ['tomato', 1]]), batches, name)).toEqual([
      { batch_id: 'E1', item_id: 'egg', delta: -2 },
      { batch_id: 'T1', item_id: 'tomato', delta: -1 },
    ]);
  });

  it('handles half units without float drift', () => {
    expect(allocateFefo(new Map([['onion', 1.5]]), [batch('A', 'onion', 0.5), batch('B', 'onion', 3)], name)).toEqual([
      { batch_id: 'A', item_id: 'onion', delta: -0.5 },
      { batch_id: 'B', item_id: 'onion', delta: -1 },
    ]);
  });

  it('reports the shortfall of the first short item', () => {
    try {
      allocateFefo(new Map([['egg', 5]]), [batch('A', 'egg', 2), batch('B', 'egg', 1)], name);
      expect.unreachable();
    } catch (err) {
      expect((err as PantryError).toBody()).toEqual({
        code: 'insufficient_stock',
        message: 'Only 3 of the 5 egg needed is in stock.',
        item: 'egg',
        need: 5,
        have: 3,
      });
    }
  });

  it('allocates nothing for an empty need', () => {
    expect(allocateFefo(new Map(), [batch('A', 'egg', 2)], name)).toEqual([]);
  });

  it('property: allocations sum to the need, never exceed a batch, and respect order', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 50 }), { minLength: 1, maxLength: 6 }), fc.integer({ min: 1, max: 300 }), (sizes, wanted) => {
        const batches = sizes.map((q, i) => batch(`b${i}`, 'x', q));
        const total = sizes.reduce((a, b) => a + b, 0);
        if (wanted > total) {
          expect(() => allocateFefo(new Map([['x', wanted]]), batches, name)).toThrow();
          return;
        }
        const lines = allocateFefo(new Map([['x', wanted]]), batches, name);
        expect(lines.reduce((a, l) => a - l.delta, 0)).toBe(wanted);
        for (const l of lines) {
          const b = batches.find((x) => x.batch_id === l.batch_id)!;
          expect(-l.delta).toBeLessThanOrEqual(b.quantity);
        }
        // Every batch before the last one used is fully drained (first-expired-first-out).
        const lastIndex = Math.max(...lines.map((l) => batches.findIndex((b) => b.batch_id === l.batch_id)));
        for (let i = 0; i < lastIndex; i++) {
          const used = lines.find((l) => l.batch_id === `b${i}`);
          expect(used ? -used.delta : 0).toBe(batches[i]!.quantity);
        }
      }),
    );
  });
});
