import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { allocateFefo, allocateReturn, type BatchStock } from '../../src/domain/allocation.ts';
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

describe('allocateReturn (§6.2)', () => {
  // In return order: the meal took from B most recently.
  const sources = [
    { batch_id: 'B', item_id: 'egg', taken: 3 },
    { batch_id: 'A', item_id: 'egg', taken: 2 },
    { batch_id: 'M', item_id: 'milk', taken: 250 },
  ];

  it('gives back to the most recent source first, each up to what it gave', () => {
    expect(allocateReturn(new Map([['egg', 4]]), sources)).toEqual([
      { batch_id: 'B', item_id: 'egg', delta: 3 },
      { batch_id: 'A', item_id: 'egg', delta: 1 },
    ]);
    expect(allocateReturn(new Map([['egg', 0.5], ['milk', 100]]), sources)).toEqual([
      { batch_id: 'B', item_id: 'egg', delta: 0.5 },
      { batch_id: 'M', item_id: 'milk', delta: 100 },
    ]);
  });

  it('throws when asked to return more than the session holds (a caller bug)', () => {
    expect(() => allocateReturn(new Map([['egg', 6]]), sources)).toThrow(/holds less egg/);
  });

  it('property: returns sum to the amount and never exceed a source', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 50 }), { minLength: 1, maxLength: 5 }), fc.nat(), (takens, seed) => {
        const src = takens.map((taken, i) => ({ batch_id: `b${i}`, item_id: 'x', taken }));
        const total = takens.reduce((a, b) => a + b, 0);
        const give = total === 0 ? 0 : seed % (total + 1);
        const lines = allocateReturn(new Map([['x', give]]), src);
        expect(lines.reduce((a, l) => a + l.delta, 0)).toBe(give);
        for (const l of lines) expect(l.delta).toBeLessThanOrEqual(src.find((s) => s.batch_id === l.batch_id)!.taken);
      }),
    );
  });
});
