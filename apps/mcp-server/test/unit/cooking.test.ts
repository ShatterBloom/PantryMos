// Recipe makeability, substitutions and planned usage (§6.3, start_cooking contract).
import { describe, expect, it } from 'vitest';
import {
  analyzeRecipe,
  type AnalysisInput,
  applySubstitute,
  demandByItem,
  ingredientCovered,
  type ItemInfo,
  type PlannedLine,
  requireMakeable,
  skipIngredient,
  stepWithSubstitutes,
  substituteOptions,
} from '../../src/domain/cooking.ts';
import type { PantryError } from '../../src/domain/errors.ts';
import type { Ingredient } from '../../src/domain/recipes.ts';

const items = new Map<string, ItemInfo>([
  ['pasta', { name: 'pasta', base_unit: 'g' }],
  ['milk', { name: 'milk', base_unit: 'ml' }],
  ['scallion', { name: 'scallion', base_unit: 'count' }],
  ['onion', { name: 'onion', base_unit: 'count' }],
  ['leek', { name: 'leek', base_unit: 'count' }],
  ['parmesan', { name: 'parmesan', base_unit: 'g' }],
  ['cheddar', { name: 'cheddar', base_unit: 'g' }],
]);

const ing = (item_id: string, quantity: number, extra: Partial<Ingredient> = {}): Ingredient => ({
  item_id,
  item: item_id,
  base_unit: items.get(item_id)!.base_unit,
  quantity,
  optional: false,
  substitutes: [],
  ...extra,
});

// "Creamy pasta" for 3: scallion may become onion (½ each) or leek (1:1); parmesan is optional.
const ingredients = [
  ing('pasta', 300),
  ing('milk', 250),
  ing('scallion', 2, { substitutes: [{ item_id: 'onion', ratio: 0.5 }, { item_id: 'leek', ratio: 1 }] }),
  ing('parmesan', 40, { optional: true, substitutes: [{ item_id: 'cheddar', ratio: 1 }] }),
];

const analyze = (available: Record<string, number>, overrides: Partial<AnalysisInput> = {}) =>
  analyzeRecipe({
    ingredients,
    recipeServings: 3,
    servings: 3,
    available: new Map(Object.entries(available)),
    substitutions: [],
    items,
    ...overrides,
  });

const full = { pasta: 500, milk: 1000, scallion: 5, parmesan: 100 };

const errorOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as PantryError).toBody();
  }
  throw new Error('expected an error');
};

describe('analyzeRecipe', () => {
  it('plans every ingredient when stock covers them', () => {
    expect(analyze(full)).toEqual({
      lines: [
        { item_id: 'pasta', quantity: 300, status: 'planned', origin: 'recipe' },
        { item_id: 'milk', quantity: 250, status: 'planned', origin: 'recipe' },
        { item_id: 'scallion', quantity: 2, status: 'planned', origin: 'recipe' },
        { item_id: 'parmesan', quantity: 40, status: 'planned', origin: 'recipe' },
      ],
      substitutions_needed: [],
      shortfall: [],
    });
  });

  it('scales to the requested servings', () => {
    const { lines } = analyze(full, { servings: 2 });
    expect(lines.map((l) => [l.item_id, l.quantity])).toEqual([
      ['pasta', 200],
      ['milk', 167],
      ['scallion', 1.5],
      ['parmesan', 27],
    ]);
  });

  it('reports a shortfall when nothing can cover an ingredient', () => {
    expect(analyze({ ...full, pasta: 100 }).shortfall).toEqual([{ item_id: 'pasta', need: 300, have: 100 }]);
  });

  it('offers only in-stock substitutes for a short ingredient, with scaled quantities', () => {
    expect(analyze({ ...full, scallion: 0, onion: 3 })).toMatchObject({
      substitutions_needed: [{ from_item_id: 'scallion', options: [{ to_item_id: 'onion', quantity: 1 }] }],
      shortfall: [],
    });
    expect(analyze({ ...full, scallion: 0, onion: 3, leek: 2 }).substitutions_needed[0]?.options).toEqual([
      { to_item_id: 'onion', quantity: 1 },
      { to_item_id: 'leek', quantity: 2 },
    ]);
  });

  it('does not offer a substitute whose stock is too low', () => {
    expect(analyze({ ...full, scallion: 0, onion: 0.5, leek: 1 })).toMatchObject({
      substitutions_needed: [],
      shortfall: [{ item_id: 'scallion', need: 2, have: 0 }],
    });
  });

  it('applies a chosen substitution: the original line is skipped, the substitute planned', () => {
    const { lines, shortfall } = analyze(
      { ...full, scallion: 0, onion: 3 },
      { substitutions: [{ from_item_id: 'scallion', to_item_id: 'onion' }] },
    );
    expect(lines).toContainEqual({ item_id: 'scallion', quantity: 2, status: 'skipped', origin: 'recipe' });
    expect(lines).toContainEqual({
      item_id: 'onion',
      quantity: 1,
      status: 'planned',
      origin: 'substitute',
      replaces_item_id: 'scallion',
    });
    expect(shortfall).toEqual([]);
    expect(demandByItem(lines).has('scallion')).toBe(false);
  });

  it('reports a chosen substitute that stock cannot cover as a shortfall', () => {
    expect(
      analyze({ ...full, scallion: 0 }, { substitutions: [{ from_item_id: 'scallion', to_item_id: 'onion' }] }).shortfall,
    ).toEqual([{ item_id: 'onion', need: 1, have: 0 }]);
  });

  it('counts a substitute against stock already planned for the same item', () => {
    const withOnion = [...ingredients, ing('onion', 2)];
    const r = analyze(
      { ...full, scallion: 0, onion: 2.5 },
      { ingredients: withOnion, substitutions: [{ from_item_id: 'scallion', to_item_id: 'onion' }] },
    );
    expect(r.shortfall).toEqual([{ item_id: 'onion', need: 3, have: 2.5 }]);
  });

  it('skips a short optional ingredient instead of blocking the recipe', () => {
    const r = analyze({ ...full, parmesan: 10 });
    expect(r.lines).toContainEqual({ item_id: 'parmesan', quantity: 40, status: 'skipped', origin: 'recipe' });
    expect(r.shortfall).toEqual([]);
    expect(r.substitutions_needed).toEqual([]);
  });

  it('rejects substitutions the recipe does not define (R28)', () => {
    expect(errorOf(() => analyze(full, { substitutions: [{ from_item_id: 'scallion', to_item_id: 'cheddar' }] }))).toMatchObject({
      code: 'invalid_substitution',
      message: "This recipe doesn't allow cheddar instead of scallion.",
      options: ['onion', 'leek'],
    });
    expect(errorOf(() => analyze(full, { substitutions: [{ from_item_id: 'onion', to_item_id: 'leek' }] }))).toMatchObject({
      code: 'invalid_substitution',
      message: "This recipe doesn't use onion.",
    });
  });
});

describe('requireMakeable', () => {
  it('returns the planned lines for a makeable recipe', () => {
    expect(requireMakeable(analyze(full), items)).toHaveLength(4);
  });

  it('names every shortfall with quantities and the options to offer (R28)', () => {
    expect(errorOf(() => requireMakeable(analyze({ ...full, pasta: 100, milk: 0 }), items))).toEqual({
      code: 'insufficient_stock',
      message: 'Not enough pasta or milk for this recipe: pasta needs 300 g, have 100; milk needs 250 ml, have 0.',
      shortfall: [
        { item: 'pasta', need: 300, have: 100, unit: 'g' },
        { item: 'milk', need: 250, have: 0, unit: 'ml' },
      ],
      options: ['make fewer servings', 'add the missing items to the shopping list', 'pick another recipe'],
    });
  });

  it('requires an explicit choice when a substitute is needed, never choosing one itself (R28)', () => {
    expect(errorOf(() => requireMakeable(analyze({ ...full, scallion: 0, onion: 3, leek: 2 }), items))).toEqual({
      code: 'substitution_required',
      message: "There isn't enough scallion.",
      from_item: 'scallion',
      options: ['onion', 'leek'],
      ask: 'Use onion or leek instead of scallion?',
    });
  });
});

describe('plan edits during cooking', () => {
  const plan: PlannedLine[] = [
    { item_id: 'pasta', quantity: 300, status: 'planned', origin: 'recipe' },
    { item_id: 'scallion', quantity: 2, status: 'planned', origin: 'recipe' },
    { item_id: 'onion', quantity: 1, status: 'planned', origin: 'recipe' },
  ];
  const scallion = ing('scallion', 2, { substitutes: [{ item_id: 'onion', ratio: 0.5 }, { item_id: 'leek', ratio: 1 }] });
  const scale = (quantity: number) => quantity; // same servings as the recipe

  it('offers substitutes covered by stock after the rest of the plan', () => {
    // 1 onion is already planned elsewhere; the swap needs 1 more.
    expect(substituteOptions(plan, scallion, scale, new Map([['onion', 1.5], ['leek', 2]]))).toEqual([
      { to_item_id: 'leek', quantity: 2 },
    ]);
    expect(substituteOptions(plan, scallion, scale, new Map([['onion', 2]]))).toEqual([{ to_item_id: 'onion', quantity: 1 }]);
  });

  it('does not count a substitute already standing in for the same ingredient against itself', () => {
    const swapped = applySubstitute(plan, 'scallion', { to_item_id: 'leek', quantity: 2 });
    expect(substituteOptions(swapped, scallion, scale, new Map([['leek', 2]]))).toEqual([{ to_item_id: 'leek', quantity: 2 }]);
  });

  it('replaces the ingredient: recipe line skipped, substitute line right after it', () => {
    expect(applySubstitute(plan, 'scallion', { to_item_id: 'leek', quantity: 2 })).toEqual([
      plan[0],
      { item_id: 'scallion', quantity: 2, status: 'skipped', origin: 'recipe' },
      { item_id: 'leek', quantity: 2, status: 'planned', origin: 'substitute', replaces_item_id: 'scallion' },
      plan[2],
    ]);
  });

  it('switches from one substitute to another without leaving the old one behind', () => {
    const first = applySubstitute(plan, 'scallion', { to_item_id: 'leek', quantity: 2 });
    const second = applySubstitute(first, 'scallion', { to_item_id: 'onion', quantity: 1 });
    expect(second.filter((l) => l.replaces_item_id === 'scallion')).toEqual([
      { item_id: 'onion', quantity: 1, status: 'planned', origin: 'substitute', replaces_item_id: 'scallion' },
    ]);
    expect(applySubstitute(second, 'scallion', { to_item_id: 'onion', quantity: 1 })).toEqual(second);
  });

  it('skips an ingredient and is a no-op when repeated', () => {
    const skipped = skipIngredient(plan, 'pasta');
    expect(skipped[0]).toEqual({ item_id: 'pasta', quantity: 300, status: 'skipped', origin: 'recipe' });
    expect(skipIngredient(skipped, 'pasta')).toEqual(skipped);
    expect(ingredientCovered(plan, 'pasta')).toBe(true);
    expect(ingredientCovered(skipped, 'pasta')).toBe(false);
  });

  it('drops the substitute standing in for a skipped ingredient, leaving other lines of that item', () => {
    const substituted = applySubstitute(plan, 'scallion', { to_item_id: 'onion', quantity: 1 });
    expect(ingredientCovered(substituted, 'scallion')).toBe(true);

    const skipped = skipIngredient(substituted, 'scallion');
    expect(skipped.filter((l) => l.replaces_item_id === 'scallion')).toEqual([]);
    expect(skipped).toContainEqual({ item_id: 'onion', quantity: 1, status: 'planned', origin: 'recipe' });
    expect(ingredientCovered(skipped, 'scallion')).toBe(false);
    expect(demandByItem(skipped).get('onion')).toBe(1);
  });
});

describe('stepWithSubstitutes', () => {
  const sub = (item_id: string, replaces_item_id: string, quantity: number, status: PlannedLine['status'] = 'planned'): PlannedLine => ({
    item_id,
    quantity,
    status,
    origin: 'substitute',
    replaces_item_id,
  });

  it('names the substitute where the step names the ingredient it stands in for', () => {
    const text = 'Soften the garlic and scallions.';
    expect(stepWithSubstitutes(text, [sub('onion', 'scallion', 1)], items)).toBe('Soften the garlic and onion.');
    expect(stepWithSubstitutes(text, [sub('onion', 'scallion', 2)], items)).toBe('Soften the garlic and onions.');
    expect(stepWithSubstitutes('Scallions last.', [sub('onion', 'scallion', 1)], items)).toBe('Onion last.');
    expect(stepWithSubstitutes('Top with the parmesan.', [sub('cheddar', 'parmesan', 40)], items)).toBe('Top with the cheddar.');
  });

  it('leaves the step as written without a planned substitute, and leaves other words alone', () => {
    const text = 'Add the scallions to the scallionless pan.';
    expect(stepWithSubstitutes(text, [], items)).toBe(text);
    expect(stepWithSubstitutes(text, [sub('onion', 'scallion', 1, 'skipped')], items)).toBe(text);
    expect(stepWithSubstitutes(text, [sub('onion', 'scallion', 1)], items)).toBe('Add the onion to the scallionless pan.');
  });
});
