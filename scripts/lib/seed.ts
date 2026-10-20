// Demo data. Every step is idempotent, so the seed can run on every `docker compose up`.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { CATALOG } from '../../db/seed/catalog.ts';
import { RECIPES } from '../../db/seed/recipes.ts';

export const INSPECTOR_CLIENT_NAME = 'inspector-dev';

export interface SeedOptions {
  householdId: string;
  householdName: string;
  /** The agent's MCP client; its token hash is (re)written on every run. */
  agent?: { clientId: string; token: string };
  /** Create a dev MCP Inspector token if the household has no active one (§11.2). */
  inspector: boolean;
}

export interface SeedResult {
  itemsCreated: number;
  recipesCreated: number;
  /** Raw Inspector token, returned only when it was just created. It is not stored anywhere. */
  inspectorToken: string | null;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function seedDemo(client: pg.ClientBase, options: SeedOptions): Promise<SeedResult> {
  await client.query('BEGIN');
  try {
    await client.query(`INSERT INTO pantry.households (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [
      options.householdId,
      options.householdName,
    ]);

    if (options.agent) {
      await client.query(
        `INSERT INTO pantry.api_clients (id, household_id, name, token_hash) VALUES ($1, $2, 'agent', $3)
         ON CONFLICT (id) DO UPDATE SET token_hash = EXCLUDED.token_hash, revoked_at = NULL`,
        [options.agent.clientId, options.householdId, sha256(options.agent.token)],
      );
    }

    let itemsCreated = 0;
    for (const item of CATALOG) {
      const res = await client.query(
        `INSERT INTO pantry.items (id, household_id, name, aliases, base_unit, category, default_shelf_days)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (household_id, lower(name)) DO NOTHING`,
        [randomUUID(), options.householdId, item.name, item.aliases ?? [], item.base_unit, item.category, item.default_shelf_days],
      );
      itemsCreated += res.rowCount ?? 0;
    }

    const recipesCreated = await seedRecipes(client, options.householdId);

    let inspectorToken: string | null = null;
    if (options.inspector) {
      const existing = await client.query(
        `SELECT 1 FROM pantry.api_clients WHERE household_id = $1 AND name = $2 AND revoked_at IS NULL`,
        [options.householdId, INSPECTOR_CLIENT_NAME],
      );
      if (existing.rowCount === 0) {
        inspectorToken = randomBytes(24).toString('hex');
        await client.query(`INSERT INTO pantry.api_clients (id, household_id, name, token_hash) VALUES ($1, $2, $3, $4)`, [
          randomUUID(),
          options.householdId,
          INSPECTOR_CLIENT_NAME,
          sha256(inspectorToken),
        ]);
      }
    }

    await client.query('COMMIT');
    return { itemsCreated, recipesCreated, inspectorToken };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

/** Inserts each recipe with its ingredients and steps, once; existing recipes are left untouched. */
async function seedRecipes(client: pg.ClientBase, householdId: string): Promise<number> {
  const { rows } = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM pantry.items WHERE household_id = $1`,
    [householdId],
  );
  const itemId = (name: string) => {
    const id = rows.find((r) => r.name === name)?.id;
    if (!id) throw new Error(`Recipe seed references unknown item "${name}"`);
    return id;
  };

  let created = 0;
  for (const recipe of RECIPES) {
    const recipeId = randomUUID();
    const res = await client.query(
      `INSERT INTO pantry.recipes (id, household_id, name, aliases, servings) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (household_id, lower(name)) DO NOTHING`,
      [recipeId, householdId, recipe.name, recipe.aliases ?? [], recipe.servings],
    );
    if (res.rowCount === 0) continue;
    created += 1;
    for (const ing of recipe.ingredients) {
      const substitutes = (ing.substitutes ?? []).map((s) => ({ item_id: itemId(s.item), ratio: s.ratio }));
      await client.query(
        `INSERT INTO pantry.recipe_ingredients (recipe_id, item_id, quantity, optional, substitutes) VALUES ($1, $2, $3, $4, $5)`,
        [recipeId, itemId(ing.item), ing.quantity, ing.optional ?? false, JSON.stringify(substitutes)],
      );
    }
    for (const [index, step] of recipe.steps.entries()) {
      await client.query(
        `INSERT INTO pantry.recipe_steps (recipe_id, step_no, text, timer_seconds, timer_label) VALUES ($1, $2, $3, $4, $5)`,
        [recipeId, index + 1, step.text, step.timer_seconds ?? null, step.timer_label ?? null],
      );
    }
  }
  return created;
}
