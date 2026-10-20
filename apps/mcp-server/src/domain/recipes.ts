// Recipes: name resolution and servings scaling (IMPLEMENTATION_PLAN §6.3, PRD FR-10).
import { PantryError } from './errors.ts';
import type { BaseUnit } from './items.ts';
import { listOr } from './speech.ts';
import { normalizeName, singular } from './text.ts';

export interface RecipeRef {
  id: string;
  name: string;
  aliases: readonly string[];
  servings: number;
}

export interface Substitute {
  item_id: string;
  /** Substitute quantity = original quantity × ratio. */
  ratio: number;
}

export interface Ingredient {
  item_id: string;
  item: string;
  base_unit: BaseUnit;
  /** Base units, for the recipe's own servings. */
  quantity: number;
  optional: boolean;
  substitutes: readonly Substitute[];
}

export interface Step {
  step_no: number;
  text: string;
  timer_seconds: number | null;
  timer_label: string | null;
}

/** Recipe names are matched like item names: normalized, then alias, then singular forms. */
export function resolveRecipe<R extends RecipeRef>(spoken: string, recipes: readonly R[]): R {
  const wanted = normalizeName(spoken).replace(/^the /, '');
  const names = (r: R) => [r.name, ...r.aliases].map(normalizeName);
  const stages: Array<(r: R) => boolean> = [
    (r) => normalizeName(r.name) === wanted,
    (r) => names(r).includes(wanted),
    (r) => names(r).some((n) => singular(n) === singular(wanted)),
  ];
  let options = recipes.map((r) => r.name);
  for (const matches of stages) {
    const found = recipes.filter(matches);
    if (found.length === 1) return found[0]!;
    if (found.length > 1) {
      options = found.map((r) => r.name);
      break;
    }
  }
  throw new PantryError('unknown_recipe', `There is no recipe called "${spoken}".`, {
    ask: options.length > 0 ? `I know ${listOr(options)}. Which one?` : 'There are no recipes yet.',
    options,
  });
}

/**
 * Scales a base-unit quantity from the recipe's servings to `servings`.
 * Counted items round to the nearest half (never below one half, so "½ onion" works);
 * grams and milliliters round to whole units (never below 1).
 */
export function scaleQuantity(quantity: number, baseUnit: BaseUnit, from: number, to: number): number {
  const exact = (quantity * to) / from;
  if (baseUnit === 'count') return Math.max(0.5, Math.round(exact * 2) / 2);
  return Math.max(1, Math.round(exact));
}
