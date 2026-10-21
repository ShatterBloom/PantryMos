import { describe, expect, it } from 'vitest';
import type { PantryError } from '../../src/domain/errors.ts';
import { checkNotNegative, defaultScope, describeReversal, netChanges, type Reversal, reversalsOf } from '../../src/domain/undo.ts';

const op = (kind: 'intake' | 'consume' | 'revise_consumption' | 'adjust') => ({ id: 'op1', kind, session_id: 's1', recipe: 'pasta' });
const reversal = (batch_id: string, item_id: string, delta: number): Reversal => ({
  reverts_event_id: `e-${batch_id}-${delta}`,
  operation_id: 'op1',
  batch_id,
  item_id,
  delta,
  session_id: null,
});

describe('defaultScope (§6.6)', () => {
  it('undoes a meal for its consume and the operation itself for intake and adjust', () => {
    expect(defaultScope(op('consume'), true)).toBe('session');
    expect(defaultScope(op('intake'), true)).toBe('operation');
    expect(defaultScope(op('adjust'), false)).toBe('operation');
    expect(defaultScope(op('revise_consumption'), false)).toBe('operation'); // named by id: that correction
  });

  it('asks whether a correction means just the correction or the whole meal', () => {
    let err: PantryError | undefined;
    try {
      defaultScope(op('revise_consumption'), true);
    } catch (e) {
      err = e as PantryError;
    }
    expect(err?.code).toBe('ambiguous_undo');
    expect(err?.details).toEqual({
      ask: 'Undo just the correction, or the whole pasta?',
      options: [
        { scope: 'operation', target: 'op1', label: 'undo the correction' },
        { scope: 'session', target: 's1', label: 'undo the whole pasta' },
      ],
    });
  });
});

describe('reversalsOf', () => {
  it('reverses each event with the opposite delta, keeping its session', () => {
    expect(reversalsOf([{ event_id: 'e1', operation_id: 'o', batch_id: 'b', item_id: 'egg', delta: -2, session_id: 's' }])).toEqual([
      { reverts_event_id: 'e1', operation_id: 'o', batch_id: 'b', item_id: 'egg', delta: 2, session_id: 's' },
    ]);
  });
});

describe('checkNotNegative', () => {
  const stock = new Map([
    ['b1', { quantity: 10, item: 'egg', unit: 'count' as const }],
    ['b2', { quantity: 1, item: 'milk', unit: 'ml' as const }],
  ]);

  it('allows reversals that leave every batch at zero or more', () => {
    expect(() => checkNotNegative([reversal('b1', 'egg', -10), reversal('b2', 'milk', 5)], stock)).not.toThrow();
  });

  it('refuses one that would take a batch below zero, offering an adjustment (R12)', () => {
    let err: PantryError | undefined;
    try {
      checkNotNegative([reversal('b1', 'egg', -12), reversal('b2', 'milk', -1)], stock);
    } catch (e) {
      err = e as PantryError;
    }
    expect(err?.code).toBe('would_go_negative');
    expect(err?.message).toBe("Some of that egg has already been used, so it can't be undone.");
    expect(err?.details).toMatchObject({ items: ['egg'], options: ['adjust the stock instead'] });
  });

  it('sums several reversals on one batch', () => {
    expect(() => checkNotNegative([reversal('b1', 'egg', -6), reversal('b1', 'egg', -5)], stock)).toThrow(/egg/);
  });
});

describe('netChanges and describeReversal', () => {
  const items = new Map([
    ['milk', { name: 'milk', base_unit: 'ml' as const }],
    ['egg', { name: 'egg', base_unit: 'count' as const }],
    ['tomato', { name: 'tomato', base_unit: 'count' as const }],
  ]);

  it('nets the change per item, by name, leaving out items that cancel out', () => {
    const changes = netChanges(
      [reversal('b2', 'milk', -50), reversal('b1', 'egg', 2), reversal('b3', 'egg', 1), reversal('b4', 'tomato', 1), reversal('b4', 'tomato', -1)],
      items,
    );
    expect(changes).toEqual([
      { item: 'egg', delta: 3, unit: 'count' },
      { item: 'milk', delta: -50, unit: 'ml' },
    ]);
    expect(describeReversal(changes)).toBe('putting back 3 eggs and taking off 50 milliliters of milk');
  });

  it('says so when nothing changes', () => {
    expect(describeReversal(netChanges([reversal('b1', 'egg', 1), reversal('b1', 'egg', -1)], items))).toBe('changing no stock');
  });
});
