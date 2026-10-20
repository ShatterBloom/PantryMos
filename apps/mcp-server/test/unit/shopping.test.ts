// Shopping list lines (§7.4 add_to_shopping_list) without a database.
import { describe, expect, it } from 'vitest';
import type { PantryError } from '../../src/domain/errors.ts';
import type { CatalogItem } from '../../src/domain/items.ts';
import { planShoppingLines, type ShoppingInput } from '../../src/domain/shopping.ts';

const item = (id: string, name: string, base_unit: CatalogItem['base_unit'], aliases: string[] = []): CatalogItem => ({
  id,
  name,
  aliases,
  base_unit,
  category: 'other',
  default_shelf_days: null,
});
const catalog = [
  item('egg-id', 'egg', 'count'),
  item('milk-id', 'milk', 'ml'),
  item('red-pepper-id', 'red pepper', 'count', ['pepper']),
  item('black-pepper-id', 'black pepper', 'g', ['pepper']),
];
const conversions = new Map([['milk-id', new Map([['carton', 1000]])]]);
const plan = (inputs: ShoppingInput[]) => planShoppingLines(inputs, catalog, conversions);
const error = (inputs: ShoppingInput[]) => {
  try {
    plan(inputs);
  } catch (err) {
    return err as PantryError;
  }
  throw new Error('expected a PantryError');
};

describe('planShoppingLines', () => {
  it('stores known names as items and anything else as free text', () => {
    expect(plan([{ name: 'Eggs' }, { name: 'dish soap' }])).toEqual([
      { item_id: 'egg-id', free_text: null, name: 'egg', quantity: null, unit: null },
      { item_id: null, free_text: 'dish soap', name: 'dish soap', quantity: null, unit: null },
    ]);
  });

  it('counts by default, and takes a base unit or a saved conversion', () => {
    expect(plan([{ name: 'egg', quantity: 6 }])[0]).toMatchObject({ quantity: 6, unit: 'count' });
    expect(plan([{ name: 'milk', quantity: 2, unit: 'cartons' }])[0]).toMatchObject({ quantity: 2, unit: 'carton' });
    expect(plan([{ name: 'milk', quantity: 1.5, unit: 'liters' }])[0]).toMatchObject({ quantity: 1.5, unit: 'l' });
    expect(plan([{ name: 'flour', quantity: 1, unit: 'kg' }])[0]).toMatchObject({ item_id: null, quantity: 1, unit: 'kg' });
    expect(plan([{ name: 'lemons', quantity: 3 }])[0]).toMatchObject({ free_text: 'lemons', quantity: 3, unit: 'count' });
  });

  it('asks for what is missing, by path', () => {
    expect(error([{ name: 'egg' }, { name: 'milk', quantity: 2 }])).toMatchObject({
      code: 'needs_clarification',
      details: { required: ['items[1].unit'] },
    });
    expect(error([{ name: 'egg', unit: 'dozen' }])).toMatchObject({
      code: 'needs_clarification',
      details: { required: ['items[0].quantity'] },
    });
  });

  it('refuses a unit that does not fit, an amount that rounds to nothing, and an ambiguous name', () => {
    expect(error([{ name: 'milk', quantity: 2, unit: 'g' }])).toMatchObject({ code: 'unit_mismatch', details: { field: 'items[0].unit' } });
    expect(error([{ name: 'soap', quantity: 2, unit: 'bottles' }]).code).toBe('unit_mismatch');
    expect(error([{ name: 'egg', quantity: 0.0001 }]).code).toBe('invalid_quantity');
    expect(error([{ name: 'pepper' }]).code).toBe('ambiguous_item');
  });
});
