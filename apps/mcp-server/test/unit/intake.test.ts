// Intake planning: every clarification branch (stories B1–B3, FR-4–FR-7) without a database.
import { describe, expect, it } from 'vitest';
import { addDays } from '../../src/domain/dates.ts';
import type { PantryError } from '../../src/domain/errors.ts';
import { type IntakeContext, type IntakeLineInput, planIntake } from '../../src/domain/intake.ts';
import type { CatalogItem } from '../../src/domain/items.ts';

const TODAY = '2026-10-20';

const item = (id: string, name: string, base_unit: CatalogItem['base_unit'], shelf: number | null, aliases: string[] = []): CatalogItem => ({
  id,
  name,
  aliases,
  base_unit,
  category: 'other',
  default_shelf_days: shelf,
});

const catalog = [
  item('egg-id', 'egg', 'count', 21),
  item('tomato-id', 'tomato', 'count', 7),
  item('milk-id', 'milk', 'ml', 7),
  item('spinach-id', 'spinach', 'g', 5),
  item('flour-id', 'flour', 'g', null),
  item('red-pepper-id', 'red pepper', 'count', 7, ['pepper']),
  item('black-pepper-id', 'black pepper', 'g', 365, ['pepper']),
];

const ctx = (overrides: Partial<IntakeContext> = {}): IntakeContext => ({
  catalog,
  conversions: new Map(),
  today: TODAY,
  ...overrides,
});

const plan = (items: IntakeLineInput[], c: IntakeContext = ctx()) => planIntake(items, c);

const failure = (items: IntakeLineInput[], c: IntakeContext = ctx()) => {
  try {
    planIntake(items, c);
  } catch (err) {
    return (err as PantryError).toBody();
  }
  throw new Error('expected planIntake to fail');
};

describe('planIntake: complete input (B1)', () => {
  it('plans one line per purchase with today as purchase date and estimated priority', () => {
    const { payload, preconditions } = plan([
      { name: 'tomatoes', quantity: 2 },
      { name: 'eggs', quantity: 1, unit: 'dozen' },
    ]);
    expect(payload.lines).toEqual([
      {
        item_id: 'tomato-id',
        new_item: null,
        item: 'tomato',
        base_unit: 'count',
        quantity_base: 2,
        quantity_shown: 2,
        unit_shown: 'count',
        purchased_at: TODAY,
        opened_at: null,
        package_date: null,
        package_date_type: null,
        priority_date: addDays(TODAY, 7),
        priority_source: 'estimate',
        date_label: 'bought today, no package date',
      },
      expect.objectContaining({ item_id: 'egg-id', quantity_base: 12, quantity_shown: 1, unit_shown: 'dozen' }),
    ]);
    expect(payload.new_items).toEqual([]);
    expect(payload.new_conversions).toEqual([]);
    expect(preconditions).toEqual({ catalog: { absent_items: [], absent_conversions: [] } });
  });

  it('renders the card and read-back from the plan', () => {
    const { payload } = plan([
      { name: 'tomato', quantity: 2 },
      { name: 'egg', quantity: 12, unit: 'count' },
    ]);
    expect(payload.card).toEqual({
      title: 'Add groceries',
      lines: ['2 tomatoes · bought today, no package date', '12 eggs · bought today, no package date'],
      warnings: [],
      readback_text: "I'll add 2 tomatoes and 12 eggs. Say confirm, or tell me what to change.",
    });
  });

  it('converts kg and l to base units and shows both on the card', () => {
    const { payload } = plan([
      { name: 'milk', quantity: 1.5, unit: 'liters' },
      { name: 'spinach', quantity: 0.2, unit: 'kg' },
    ]);
    expect(payload.lines.map((l) => [l.quantity_base, l.unit_shown])).toEqual([
      [1500, 'l'],
      [200, 'kg'],
    ]);
    expect(payload.card.lines[0]).toBe('1.5 liters of milk (1500 ml) · bought today, no package date');
  });

  it('uses the purchase date the user gave (B1: "bought it yesterday")', () => {
    const { payload } = plan([{ name: 'milk', quantity: 1000, unit: 'ml', purchased_at: addDays(TODAY, -1) }]);
    expect(payload.lines[0]).toMatchObject({
      purchased_at: addDays(TODAY, -1),
      priority_date: addDays(TODAY, 6),
      date_label: 'stored for 1 day, no package date',
    });
    expect(payload.card.readback_text).toBe(
      "I'll add 1000 milliliters of milk, bought Oct 19. Say confirm, or tell me what to change.",
    );
  });

  it('records package dates as given, with their source (B3)', () => {
    const { payload } = plan([
      { name: 'milk', quantity: 1, unit: 'l', package_date: '2026-10-28', package_date_type: 'best_by' },
      { name: 'spinach', quantity: 100, unit: 'g', package_date: '2026-10-22' },
    ]);
    expect(payload.lines[0]).toMatchObject({
      package_date: '2026-10-28',
      package_date_type: 'best_by',
      priority_date: '2026-10-28',
      priority_source: 'package',
      date_label: 'best by Oct 28 (from package)',
    });
    // No type given: shown as a plain package date, never as an expiry.
    expect(payload.lines[1]).toMatchObject({ package_date_type: 'unknown', date_label: 'dated Oct 22 on package' });
    expect(payload.card.readback_text).toContain('1 liter of milk, best by Oct 28');
    expect(payload.card.readback_text).toContain('100 grams of spinach, dated Oct 22');
  });

  it('falls back to a 7-day estimate when the item has no shelf days', () => {
    expect(plan([{ name: 'flour', quantity: 1, unit: 'kg' }]).payload.lines[0]?.priority_date).toBe(addDays(TODAY, 7));
  });

  it('keeps an opened date and shows it in the label', () => {
    const { payload } = plan([
      { name: 'milk', quantity: 500, unit: 'ml', purchased_at: addDays(TODAY, -2), opened_at: addDays(TODAY, -1) },
    ]);
    expect(payload.lines[0]?.date_label).toBe('stored for 2 days, no package date, opened Oct 19');
  });
});

describe('planIntake: asks instead of guessing (B2, FR-4)', () => {
  it('asks for a missing quantity', () => {
    expect(failure([{ name: 'eggs' }])).toEqual({
      code: 'needs_clarification',
      message: 'The quantity of egg is missing.',
      ask: 'How many eggs?',
      required: ['items[0].quantity'],
    });
  });

  it('asks for the unit of something weighed or measured, but not of something counted', () => {
    expect(failure([{ name: 'spinach', quantity: 2 }])).toMatchObject({
      code: 'needs_clarification',
      ask: 'How much spinach, in grams?',
      required: ['items[0].unit'],
    });
    expect(plan([{ name: 'tomato', quantity: 2 }]).payload.lines[0]?.unit_shown).toBe('count');
  });

  it('asks how many are in an unknown package unit, in canonical form (B2: carton)', () => {
    expect(failure([{ name: 'eggs', quantity: 1, unit: 'cartons' }])).toEqual({
      code: 'needs_clarification',
      message: "I don't know how much egg is in a carton.",
      ask: 'How many eggs are in a carton?',
      required: ['items[0].unit_conversion.unit', 'items[0].unit_conversion.base_qty'],
      unit: 'carton',
    });
    expect(failure([{ name: 'flour', quantity: 1, unit: 'bag' }]).ask).toBe('How many grams of flour are in a bag?');
  });

  it('plans with a conversion supplied on the re-call, and saves it (R22)', () => {
    const { payload, preconditions } = plan([
      { name: 'eggs', quantity: 1, unit: 'carton', unit_conversion: { unit: 'Cartons', base_qty: 12 } },
    ]);
    expect(payload.lines[0]).toMatchObject({ item_id: 'egg-id', quantity_base: 12, unit_shown: 'carton' });
    expect(payload.new_conversions).toEqual([
      { item_id: 'egg-id', new_item: null, item: 'egg', base_unit: 'count', unit: 'carton', base_qty: 12 },
    ]);
    expect(payload.card.warnings).toEqual(['Saved: 1 carton = 12 eggs']);
    expect(payload.card.lines[0]).toBe('1 carton of eggs (12 count) · bought today, no package date');
    expect(payload.card.readback_text).toBe(
      "I'll add 1 carton of eggs. I'll remember that 1 carton = 12 eggs. Say confirm, or tell me what to change.",
    );
    expect(preconditions.catalog.absent_conversions).toEqual([{ item_id: 'egg-id', new_item: null, unit: 'carton' }]);
  });

  it('reuses a saved conversion without asking again (B2)', () => {
    const saved = ctx({ conversions: new Map([['egg-id', new Map([['carton', 12]])]]) });
    const { payload, preconditions } = plan([{ name: 'eggs', quantity: 2, unit: 'carton' }], saved);
    expect(payload.lines[0]?.quantity_base).toBe(24);
    expect(payload.new_conversions).toEqual([]);
    expect(preconditions.catalog.absent_conversions).toEqual([]);
  });

  it('uses a one-off package size without overwriting the saved conversion', () => {
    const saved = ctx({ conversions: new Map([['egg-id', new Map([['carton', 12]])]]) });
    const { payload } = plan([{ name: 'egg', quantity: 1, unit: 'carton', unit_conversion: { unit: 'carton', base_qty: 18 } }], saved);
    expect(payload.lines[0]?.quantity_base).toBe(18);
    expect(payload.new_conversions).toEqual([]);
  });

  it('saves a conversion once even if several lines use it', () => {
    const conversion = { unit: 'carton', base_qty: 12 };
    const { payload } = plan([
      { name: 'egg', quantity: 1, unit: 'carton', unit_conversion: conversion },
      { name: 'egg', quantity: 2, unit: 'carton', unit_conversion: conversion },
    ]);
    expect(payload.lines.map((l) => l.quantity_base)).toEqual([12, 24]);
    expect(payload.new_conversions).toHaveLength(1);
  });

  it('does not save a conversion that no line used', () => {
    const { payload } = plan([{ name: 'egg', quantity: 12, unit: 'count', unit_conversion: { unit: 'carton', base_qty: 12 } }]);
    expect(payload.new_conversions).toEqual([]);
  });

  it('rejects a "conversion" for a standard unit', () => {
    expect(failure([{ name: 'egg', quantity: 1, unit: 'count', unit_conversion: { unit: 'grams', base_qty: 50 } }])).toMatchObject({
      code: 'unit_mismatch',
      field: 'items[0].unit_conversion.unit',
    });
  });

  it('rejects a unit of the wrong dimension', () => {
    expect(failure([{ name: 'egg', quantity: 100, unit: 'g' }])).toEqual({
      code: 'unit_mismatch',
      message: 'egg is counted, so "g" does not fit.',
      ask: 'How many eggs?',
      field: 'items[0].unit',
    });
    expect(failure([{ name: 'milk', quantity: 1, unit: 'kg' }]).message).toBe('milk is measured by volume, so "kg" does not fit.');
    expect(failure([{ name: 'spinach', quantity: 1, unit: 'l' }]).message).toBe('spinach is weighed, so "l" does not fit.');
  });

  it('asks which item is meant when the name is ambiguous', () => {
    expect(failure([{ name: 'pepper', quantity: 1 }])).toMatchObject({
      code: 'ambiguous_item',
      options: ['red pepper', 'black pepper'],
    });
  });
});

describe('planIntake: new items (B2, R21)', () => {
  it('asks what an unknown item is, naming the exact fields needed', () => {
    expect(failure([{ name: 'Oat Milk', quantity: 1, unit: 'l' }])).toEqual({
      code: 'unknown_item',
      message: 'There is no oat milk in the catalog yet.',
      ask: 'Did you mean milk? If not, what kind of food is oat milk, and is it counted, weighed in grams, or measured in milliliters?',
      required: ['items[0].new_item.category', 'items[0].new_item.base_unit'],
      suggestions: ['milk'],
    });
    expect(failure([{ name: 'salmon', quantity: 1 }]).ask).toBe(
      'What kind of food is salmon, and is it counted, weighed in grams, or measured in milliliters?',
    );
  });

  it('creates the item inside the proposal, shown explicitly on the card', () => {
    const { payload, preconditions } = plan([
      { name: 'Oat Milk', quantity: 1, unit: 'l', new_item: { category: 'dairy', base_unit: 'ml', default_shelf_days: 10 } },
    ]);
    expect(payload.new_items).toEqual([
      { key: 'oat milk', name: 'oat milk', category: 'dairy', base_unit: 'ml', default_shelf_days: 10 },
    ]);
    expect(payload.lines[0]).toMatchObject({
      item_id: null,
      new_item: 'oat milk',
      quantity_base: 1000,
      priority_date: addDays(TODAY, 10),
    });
    expect(payload.card.warnings).toEqual(['New item: oat milk · dairy · ml']);
    expect(payload.card.readback_text).toContain('New item: oat milk.');
    expect(preconditions.catalog.absent_items).toEqual(['oat milk']);
  });

  it('stores a new item under its singular name, so it is never pluralized twice', () => {
    const { payload, preconditions } = plan([
      { name: 'Apples', quantity: 6, new_item: { category: 'produce', base_unit: 'count' } },
    ]);
    expect(payload.new_items).toEqual([
      { key: 'apple', name: 'apple', category: 'produce', base_unit: 'count', default_shelf_days: null },
    ]);
    expect(payload.lines[0]).toMatchObject({ item: 'apple', new_item: 'apple' });
    expect(payload.card.lines[0]).toBe('6 apples · bought today, no package date');
    expect(payload.card.warnings).toEqual(['New item: apple · produce · count']);
    expect(payload.card.readback_text).toBe("I'll add 6 apples. New item: apple. Say confirm, or tell me what to change.");
    expect(preconditions.catalog.absent_items).toEqual(['apple']);
    // The singular and plural spellings plan the same new item.
    const singularPlan = plan([{ name: 'apple', quantity: 6, new_item: { category: 'produce', base_unit: 'count' } }]);
    expect(singularPlan.preconditions).toEqual(preconditions);
  });

  it('still asks about an unknown item in the words the user used', () => {
    expect(failure([{ name: 'Apples', quantity: 6 }]).message).toBe('There is no apples in the catalog yet.');
  });

  it('lets later lines refer to a new item defined earlier, in any form', () => {
    const { payload } = plan([
      { name: 'blueberry', quantity: 125, unit: 'g', new_item: { category: 'produce', base_unit: 'g' } },
      { name: 'Blueberries', quantity: 125, unit: 'g' },
    ]);
    expect(payload.new_items).toHaveLength(1);
    expect(payload.lines.map((l) => l.new_item)).toEqual(['blueberry', 'blueberry']);
  });

  it('ignores new_item for a name already in the catalog', () => {
    const { payload } = plan([{ name: 'egg', quantity: 6, new_item: { category: 'dairy', base_unit: 'count' } }]);
    expect(payload.new_items).toEqual([]);
    expect(payload.lines[0]?.item_id).toBe('egg-id');
  });

  it('learns a package unit for a new item in the same card', () => {
    const { payload, preconditions } = plan([
      {
        name: 'quail egg',
        quantity: 1,
        unit: 'box',
        new_item: { category: 'dairy', base_unit: 'count' },
        unit_conversion: { unit: 'box', base_qty: 18 },
      },
    ]);
    expect(payload.lines[0]?.quantity_base).toBe(18);
    expect(payload.new_conversions).toEqual([
      { item_id: null, new_item: 'quail egg', item: 'quail egg', base_unit: 'count', unit: 'box', base_qty: 18 },
    ]);
    expect(preconditions.catalog).toEqual({
      absent_items: ['quail egg'],
      absent_conversions: [{ item_id: null, new_item: 'quail egg', unit: 'box' }],
    });
  });
});

describe('planIntake: one question at a time (FR-2)', () => {
  it('reports the first problem and gathers required paths of the same kind', () => {
    expect(
      failure([
        { name: 'egg', quantity: 6 },
        { name: 'tomato' },
        { name: 'oat milk', quantity: 1, unit: 'l' },
        { name: 'spinach' },
      ]),
    ).toMatchObject({
      code: 'needs_clarification',
      ask: 'How many tomatoes?',
      required: ['items[1].quantity', 'items[3].quantity'],
    });
  });

  it('does not merge different questions that share an error code', () => {
    expect(
      failure([
        { name: 'tomato' },
        { name: 'spinach', quantity: 2 },
        { name: 'egg' },
      ]),
    ).toEqual({
      code: 'needs_clarification',
      message: 'The quantity of tomato is missing.',
      ask: 'How many tomatoes?',
      required: ['items[0].quantity', 'items[2].quantity'],
    });
  });

  it('asks the next question on the following call', () => {
    expect(failure([{ name: 'tomato', quantity: 2 }, { name: 'spinach', quantity: 2 }, { name: 'egg', quantity: 6 }])).toMatchObject({
      ask: 'How much spinach, in grams?',
      required: ['items[1].unit'],
    });
  });

  it('reports an unknown item first if it comes first', () => {
    expect(failure([{ name: 'oat milk', quantity: 1, unit: 'l' }, { name: 'tomato' }]).code).toBe('unknown_item');
  });
});

describe('planIntake: validation', () => {
  it('rejects quantities outside (0, 100000] base units', () => {
    expect(failure([{ name: 'flour', quantity: 101, unit: 'kg' }])).toMatchObject({
      code: 'invalid_quantity',
      field: 'items[0].quantity',
    });
    expect(failure([{ name: 'flour', quantity: 0.0001, unit: 'g' }]).code).toBe('invalid_quantity');
    expect(plan([{ name: 'flour', quantity: 100, unit: 'kg' }]).payload.lines[0]?.quantity_base).toBe(100_000);
  });

  it('validates dates against today and names the field', () => {
    expect(failure([{ name: 'egg', quantity: 1, purchased_at: addDays(TODAY, 1) }])).toMatchObject({
      code: 'invalid_date',
      field: 'items[0].purchased_at',
    });
    expect(failure([{ name: 'egg', quantity: 1, package_date: '2026-02-30' }]).field).toBe('items[0].package_date');
  });

  it('rejects a package date type without a package date', () => {
    expect(failure([{ name: 'egg', quantity: 1, package_date_type: 'use_by' }])).toMatchObject({
      code: 'invalid_date',
      field: 'items[0].package_date',
    });
  });

  it('is deterministic: the same input plans the same payload', () => {
    const input: IntakeLineInput[] = [
      { name: 'eggs', quantity: 1, unit: 'carton', unit_conversion: { unit: 'carton', base_qty: 12 } },
      { name: 'oat milk', quantity: 1, unit: 'l', new_item: { category: 'dairy', base_unit: 'ml' } },
    ];
    expect(plan(input)).toEqual(plan(input));
  });
});
