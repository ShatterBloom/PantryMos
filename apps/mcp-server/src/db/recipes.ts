import type { Ingredient, RecipeRef, Step } from '../domain/recipes.ts';
import type { Queryable } from './catalog.ts';

export async function loadRecipes(q: Queryable, householdId: string): Promise<RecipeRef[]> {
  const { rows } = await q.query<RecipeRef>(
    `SELECT id, name, aliases, servings FROM pantry.recipes WHERE household_id = $1 ORDER BY name`,
    [householdId],
  );
  return rows;
}

export async function loadIngredients(q: Queryable, recipeId: string): Promise<Ingredient[]> {
  const { rows } = await q.query<Omit<Ingredient, 'quantity'> & { quantity: string }>(
    `SELECT ri.item_id, i.name AS item, i.base_unit, ri.quantity::text AS quantity, ri.optional, ri.substitutes
       FROM pantry.recipe_ingredients ri JOIN pantry.items i ON i.id = ri.item_id
      WHERE ri.recipe_id = $1
      ORDER BY i.name`,
    [recipeId],
  );
  return rows.map((r) => ({ ...r, quantity: Number(r.quantity) }));
}

export async function loadSteps(q: Queryable, recipeId: string): Promise<Step[]> {
  const { rows } = await q.query<Step>(
    `SELECT step_no, text, timer_seconds, timer_label FROM pantry.recipe_steps WHERE recipe_id = $1 ORDER BY step_no`,
    [recipeId],
  );
  return rows;
}
