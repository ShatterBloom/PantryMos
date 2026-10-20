// The demo seed against real Postgres: idempotent, and its tokens authenticate.
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CATALOG } from '../../../../db/seed/catalog.ts';
import { RECIPES } from '../../../../db/seed/recipes.ts';
import { INSPECTOR_CLIENT_NAME, seedDemo } from '../../../../scripts/lib/seed.ts';
import { createPool, type Pool } from '../../src/db/pool.ts';
import { resolveClient } from '../../src/security/auth.ts';
import { TEST_ADMIN_URL, TEST_MCP_DB_URL } from '../../../../test/env.ts';

describe('seedDemo', () => {
  const admin = new pg.Client({ connectionString: TEST_ADMIN_URL });
  let pool: Pool;

  beforeAll(async () => {
    await admin.connect();
    pool = createPool(TEST_MCP_DB_URL);
  });
  afterAll(async () => {
    await admin.end();
    await pool.end();
  });

  const fresh = () => ({
    householdId: randomUUID(),
    householdName: 'Seed test',
    agent: { clientId: randomUUID(), token: randomBytes(24).toString('hex') },
    inspector: true,
  });

  it('creates the household, catalog and both tokens on the first run', async () => {
    const options = fresh();
    const result = await seedDemo(admin, options);

    expect(result.itemsCreated).toBe(CATALOG.length);
    expect(result.recipesCreated).toBe(RECIPES.length);
    expect(result.inspectorToken).toMatch(/^[0-9a-f]{48}$/);
    expect(await resolveClient(pool, options.agent.token)).toEqual({
      clientId: options.agent.clientId,
      householdId: options.householdId,
    });
    expect((await resolveClient(pool, result.inspectorToken!))?.householdId).toBe(options.householdId);

    const { rows } = await admin.query(
      `SELECT name, aliases, base_unit, category, default_shelf_days FROM pantry.items WHERE household_id = $1 AND name = 'scallion'`,
      [options.householdId],
    );
    expect(rows[0]).toEqual({
      name: 'scallion',
      aliases: ['green onion', 'spring onion'],
      base_unit: 'count',
      category: 'produce',
      default_shelf_days: 7,
    });
  });

  it('stores recipes with ingredients, substitutes and timed steps', async () => {
    const options = fresh();
    await seedDemo(admin, options);
    const { rows } = await admin.query(
      `SELECT r.servings,
              (SELECT json_agg(json_build_object('item', i.name, 'quantity', ri.quantity::int, 'optional', ri.optional,
                                                 'subs', (SELECT json_agg(s.name) FROM jsonb_array_elements(ri.substitutes) x
                                                            JOIN pantry.items s ON s.id = (x->>'item_id')::uuid))
                        ORDER BY i.name)
                 FROM pantry.recipe_ingredients ri JOIN pantry.items i ON i.id = ri.item_id WHERE ri.recipe_id = r.id) AS ingredients,
              (SELECT json_agg(json_build_object('n', step_no, 'timer', timer_seconds, 'label', timer_label) ORDER BY step_no)
                 FROM pantry.recipe_steps WHERE recipe_id = r.id) AS steps
         FROM pantry.recipes r WHERE r.household_id = $1 AND r.name = 'creamy spinach pasta'`,
      [options.householdId],
    );
    expect(rows[0].servings).toBe(3);
    expect(rows[0].ingredients).toContainEqual({ item: 'scallion', quantity: 2, optional: false, subs: ['onion'] });
    expect(rows[0].ingredients).toContainEqual({ item: 'parmesan', quantity: 40, optional: true, subs: ['cheddar'] });
    expect(rows[0].steps[1]).toEqual({ n: 2, timer: 480, label: 'pasta' });
  });

  it('is idempotent: a second run adds nothing and does not mint another Inspector token', async () => {
    const options = fresh();
    await seedDemo(admin, options);
    const again = await seedDemo(admin, options);

    expect(again).toEqual({ itemsCreated: 0, recipesCreated: 0, inspectorToken: null });
    const counts = await admin.query(
      `SELECT (SELECT count(*) FROM pantry.items WHERE household_id = $1)::int AS items,
              (SELECT count(*) FROM pantry.api_clients WHERE household_id = $1 AND name = $2)::int AS inspectors`,
      [options.householdId, INSPECTOR_CLIENT_NAME],
    );
    expect(counts.rows[0]).toEqual({ items: CATALOG.length, inspectors: 1 });
  });

  it('rotates the agent token and re-activates a revoked agent client', async () => {
    const options = fresh();
    await seedDemo(admin, options);
    await admin.query(`UPDATE pantry.api_clients SET revoked_at = now() WHERE id = $1`, [options.agent.clientId]);

    const rotated = { ...options, agent: { ...options.agent, token: randomBytes(24).toString('hex') } };
    await seedDemo(admin, rotated);

    expect(await resolveClient(pool, options.agent.token)).toBeNull();
    expect((await resolveClient(pool, rotated.agent.token))?.clientId).toBe(options.agent.clientId);
  });

  it('mints a new Inspector token after the previous one was revoked', async () => {
    const options = fresh();
    const first = await seedDemo(admin, options);
    await admin.query(`UPDATE pantry.api_clients SET revoked_at = now() WHERE household_id = $1 AND name = $2`, [
      options.householdId,
      INSPECTOR_CLIENT_NAME,
    ]);
    const second = await seedDemo(admin, options);

    expect(second.inspectorToken).not.toBeNull();
    expect(second.inspectorToken).not.toBe(first.inspectorToken);
    expect(await resolveClient(pool, first.inspectorToken!)).toBeNull();
  });

  it('rolls back everything if a step fails', async () => {
    const options = { ...fresh(), agent: { clientId: 'not-a-uuid', token: 'x' } };
    await expect(seedDemo(admin, options)).rejects.toThrow();
    const { rowCount } = await admin.query(`SELECT 1 FROM pantry.households WHERE id = $1`, [options.householdId]);
    expect(rowCount).toBe(0);
  });
});
