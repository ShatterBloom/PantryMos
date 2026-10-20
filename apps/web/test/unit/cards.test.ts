// Card edits become the PATCH changes mcp-server expects (domain/editable.ts), and option buttons read well.
import { describe, expect, it } from 'vitest';
import type { Editable } from '../../src/lib/api.ts';
import { editableAmounts, editChanges, optionLabel } from '../../src/lib/cards.ts';

describe('editChanges', () => {
  const intake: NonNullable<Editable> = {
    type: 'items',
    items: [
      { name: 'milk', quantity: 2, unit: 'l', package_date: '2026-10-30' },
      { name: 'egg', quantity: 6 },
    ],
    lines: [
      { item: 'milk', quantity: 2, unit: 'l' },
      { item: 'egg', quantity: 6, unit: 'count' },
    ],
  };

  it('sends every intake item with its new amount, leaving out lines set to 0', () => {
    expect(editableAmounts(intake)).toEqual([2, 6]);
    expect(editChanges(intake, [2, 6])).toBeNull();
    expect(editChanges(intake, [1, 6])).toEqual({
      items: [
        { name: 'milk', quantity: 1, unit: 'l', package_date: '2026-10-30' },
        { name: 'egg', quantity: 6 },
      ],
    });
    expect(editChanges(intake, [2, 0])).toEqual({ items: [{ name: 'milk', quantity: 2, unit: 'l', package_date: '2026-10-30' }] });
    expect(editChanges(intake, [0, 0])).toBeNull(); // an intake needs at least one item: discard it instead
  });

  it('sends only the changed consume or revise lines', () => {
    const consume: NonNullable<Editable> = {
      type: 'lines',
      field: 'overrides',
      lines: [
        { item: 'egg', quantity: 3, unit: 'count' },
        { item: 'milk', quantity: 200, unit: 'ml' },
      ],
    };
    expect(editChanges(consume, [3, 200])).toBeNull();
    expect(editChanges(consume, [2, 200])).toEqual({ overrides: [{ item: 'egg', quantity: 2 }] });
    expect(editChanges({ ...consume, field: 'usage' }, [3, 0])).toEqual({ usage: [{ item: 'milk', quantity: 0 }] });
  });

  it('sends the one adjustment field', () => {
    const adjust: NonNullable<Editable> = { type: 'amount', field: 'delta', item: 'egg', value: -2, unit: 'count' };
    expect(editableAmounts(adjust)).toEqual([-2]);
    expect(editChanges(adjust, [-2])).toBeNull();
    expect(editChanges(adjust, [-3])).toEqual({ delta: -3 });
    expect(editChanges({ ...adjust, field: 'set_quantity', value: 4 }, [5])).toEqual({ set_quantity: 5 });
  });
});

describe('optionLabel', () => {
  it('reads labelled choices first: undo scopes and has_dependents', () => {
    // mcp-server domain/undo.ts and proposals/undo.ts
    expect(optionLabel({ scope: 'operation', target: 'op-1', label: 'undo the correction' })).toBe('undo the correction');
    expect(optionLabel({ scope: 'session', target: 's-1', label: 'undo the whole meal' })).toBe('undo the whole meal');
    expect(optionLabel({ label: 'x', name: 'y' })).toBe('x');
  });

  it('reads names, suggestions, batches and substitutes', () => {
    expect(optionLabel('cherry tomato')).toBe('cherry tomato');
    expect(optionLabel({ batch_id: 'b1', quantity: 4, date_label: 'stored for 3 days, no package date' })).toBe(
      'the one stored for 3 days, no package date',
    );
    expect(optionLabel({ batch_id: 'new', date_label: 'new batch' })).toBe('a new batch');
    expect(optionLabel({ name: 'onion' })).toBe('onion');
    expect(optionLabel({ item: 'onion', quantity: 1, unit: 'count' })).toBe('onion');
    expect(optionLabel({ to_item: 'onion', quantity: 1, in_stock: true })).toBe('onion');
    expect(optionLabel({ something: 'else' })).toBeNull();
    expect(optionLabel(42)).toBeNull();
    expect(optionLabel(null)).toBeNull();
  });
});
