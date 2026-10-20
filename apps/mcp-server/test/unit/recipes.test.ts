import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CATALOG } from '../../../../db/seed/catalog.ts';
import { RECIPES } from '../../../../db/seed/recipes.ts';
import type { PantryError } from '../../src/domain/errors.ts';
import { type RecipeRef, resolveRecipe, scaleQuantity } from '../../src/domain/recipes.ts';

const recipe = (name: string, aliases: string[] = []): RecipeRef => ({ id: name, name, aliases, servings: 2 });
const recipes = [
  recipe('creamy spinach pasta', ['spinach pasta']),
  recipe('tomato egg stir-fry', ['tomato and egg stir-fry']),
  recipe('spinach omelette', ['spinach omelet']),
  recipe('spinach soup', ['spinach pasta']), // shares an alias, to test ambiguity
];

const failure = (spoken: string, list = recipes) => {
  try {
    resolveRecipe(spoken, list);
  } catch (err) {
    return (err as PantryError).toBody();
  }
  throw new Error('expected a failure');
};

describe('resolveRecipe', () => {
  it('matches the name, ignoring case, spacing and a leading "the"', () => {
    expect(resolveRecipe('Tomato Egg  Stir-Fry', recipes).name).toBe('tomato egg stir-fry');
    expect(resolveRecipe('the spinach omelette', recipes).name).toBe('spinach omelette');
  });

  it('matches an alias and singular/plural forms', () => {
    expect(resolveRecipe('tomato and egg stir-fry', recipes).name).toBe('tomato egg stir-fry');
    expect(resolveRecipe('spinach omelets', recipes).name).toBe('spinach omelette');
  });

  it('prefers the exact name over an alias another recipe shares', () => {
    expect(resolveRecipe('creamy spinach pasta', recipes).name).toBe('creamy spinach pasta');
  });

  it('lists only the matching recipes when a name is ambiguous', () => {
    expect(failure('spinach pasta')).toMatchObject({
      code: 'unknown_recipe',
      options: ['creamy spinach pasta', 'spinach soup'],
    });
  });

  it('lists every recipe when nothing matches', () => {
    expect(failure('beef wellington')).toEqual({
      code: 'unknown_recipe',
      message: 'There is no recipe called "beef wellington".',
      ask: 'I know creamy spinach pasta, tomato egg stir-fry, spinach omelette or spinach soup. Which one?',
      options: ['creamy spinach pasta', 'tomato egg stir-fry', 'spinach omelette', 'spinach soup'],
    });
    expect(failure('anything', []).ask).toBe('There are no recipes yet.');
  });
});

describe('scaleQuantity', () => {
  it('scales by servings', () => {
    expect(scaleQuantity(300, 'g', 3, 3)).toBe(300);
    expect(scaleQuantity(300, 'g', 3, 2)).toBe(200);
    expect(scaleQuantity(250, 'ml', 3, 4)).toBe(333);
    expect(scaleQuantity(2, 'count', 2, 3)).toBe(3);
  });

  it('rounds counted items to the nearest half, at least one half', () => {
    expect(scaleQuantity(1, 'count', 2, 3)).toBe(1.5);
    expect(scaleQuantity(3, 'count', 2, 3)).toBe(4.5);
    expect(scaleQuantity(1, 'count', 4, 1)).toBe(0.5);
    expect(scaleQuantity(1, 'count', 12, 1)).toBe(0.5);
  });

  it('never scales grams or milliliters below one', () => {
    expect(scaleQuantity(5, 'ml', 12, 1)).toBe(1);
  });

  it('property: identity at the recipe servings, monotonic in servings', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2000 }),
        fc.constantFrom('g' as const, 'ml' as const, 'count' as const),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 11 }),
        (quantity, unit, from, to) => {
          expect(scaleQuantity(quantity, unit, from, from)).toBe(quantity);
          expect(scaleQuantity(quantity, unit, from, to + 1)).toBeGreaterThanOrEqual(scaleQuantity(quantity, unit, from, to));
        },
      ),
    );
  });
});

describe('demo recipes (seed data)', () => {
  const items = new Map(CATALOG.map((i) => [i.name, i]));

  it('has 3-5 recipes with unique names (FR-10)', () => {
    expect(RECIPES.length).toBeGreaterThanOrEqual(3);
    expect(RECIPES.length).toBeLessThanOrEqual(5);
    expect(new Set(RECIPES.map((r) => r.name)).size).toBe(RECIPES.length);
  });

  it('uses only catalog items, positive quantities and distinct ingredients', () => {
    for (const r of RECIPES) {
      expect(r.servings).toBeGreaterThan(0);
      const names = r.ingredients.map((i) => i.item);
      expect(new Set(names).size).toBe(names.length);
      for (const ing of r.ingredients) {
        expect(items.has(ing.item), `${r.name}: ${ing.item}`).toBe(true);
        expect(ing.quantity).toBeGreaterThan(0);
        for (const sub of ing.substitutes ?? []) {
          expect(items.has(sub.item), `${r.name}: substitute ${sub.item}`).toBe(true);
          expect(sub.item).not.toBe(ing.item);
          expect(sub.ratio).toBeGreaterThan(0);
          expect(items.get(sub.item)?.base_unit).toBe(items.get(ing.item)?.base_unit);
        }
      }
    }
  });

  it('has steps with text and timers inside the database range (10 s - 2 h)', () => {
    for (const r of RECIPES) {
      expect(r.steps.length).toBeGreaterThan(0);
      for (const step of r.steps) {
        expect(step.text.length).toBeGreaterThan(10);
        if (step.timer_seconds !== undefined) {
          expect(step.timer_seconds).toBeGreaterThanOrEqual(10);
          expect(step.timer_seconds).toBeLessThanOrEqual(7200);
          expect(step.timer_label).toBeDefined();
        }
      }
    }
  });

  it('supports the demo narrative: dinner for three, scallion → onion, an 8-minute pasta timer, milk', () => {
    const pasta = RECIPES.find((r) => r.name === 'creamy spinach pasta')!;
    expect(pasta.servings).toBe(3);
    expect(pasta.ingredients.find((i) => i.item === 'scallion')?.substitutes).toEqual([{ item: 'onion', ratio: 0.5 }]);
    expect(pasta.ingredients.some((i) => i.item === 'milk')).toBe(true);
    expect(pasta.steps.find((s) => s.timer_label === 'pasta')?.timer_seconds).toBe(480);
  });
});
