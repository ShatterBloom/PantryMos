// start_cooking and get_session over MCP against the real demo recipes (D1, D2, I1, R28).
import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type RunningServers, startServers } from '../../src/app.ts';
import { parseErrorResult } from '../../src/mcp/toolkit.ts';
import {
  callWrite,
  connectMcpClient,
  createDemoKitchen,
  type DemoKitchen,
  mcpTestConfig,
  stockKitchen,
  withAdmin,
} from '../../../../test/fixtures.ts';

/** Enough of everything for creamy spinach pasta for 3, except scallions. */
const PASTA_STOCK = { pasta: 500, spinach: 300, milk: 1000, 'garlic clove': 5, butter: 100, parmesan: 100 };

interface Started {
  session_id: string;
  recipe: string;
  servings: number;
  step_no: number;
  total_steps: number;
  step_text: string;
  timer_seconds: number | null;
  applied_substitutions: Array<{ from_item: string; to_item: string; quantity: number }>;
}

describe('start_cooking and get_session', () => {
  let servers: RunningServers;

  beforeAll(async () => {
    servers = await startServers(mcpTestConfig(), { log: false });
  });
  afterAll(async () => servers.close());

  let kitchen: DemoKitchen;
  let client: Client;
  beforeEach(async () => {
    kitchen = await createDemoKitchen();
    client = await connectMcpClient(servers, kitchen.token);
    await client.listTools(); // the SDK client then validates success results against output schemas
    return () => client.close();
  });

  const start = (args: Record<string, unknown>, ids?: { requestId?: string; conversationId?: string }) =>
    callWrite(client, 'start_cooking', args, ids);
  const session = async (id: string) =>
    withAdmin(async (admin) => (await admin.query(`SELECT * FROM pantry.cooking_sessions WHERE id = $1`, [id])).rows[0]);

  it('starts a recipe at step 1 with the planned usage, changing no inventory (D1)', async () => {
    await stockKitchen(kitchen, { ...PASTA_STOCK, scallion: 4 });
    const conversationId = randomUUID();
    const res = await start({ recipe_name: 'Creamy Spinach Pasta' }, { conversationId });
    expect(parseErrorResult(res)).toBeNull();
    const out = res.structuredContent as unknown as Started;
    expect(out).toMatchObject({
      recipe: 'creamy spinach pasta',
      servings: 3,
      step_no: 1,
      total_steps: 6,
      step_text: 'Bring a large pot of salted water to a boil.',
      timer_seconds: null,
      applied_substitutions: [],
    });

    const row = await session(out.session_id);
    expect(row).toMatchObject({ state: 'cooking', current_step: 1, total_steps: 6, servings: 3, state_version: 1, conversation_id: conversationId });
    expect(row.planned_usage).toContainEqual({ item_id: kitchen.items.scallion, quantity: 2, status: 'planned', origin: 'recipe' });
    const events = await withAdmin(async (admin) =>
      admin.query(`SELECT 1 FROM pantry.inventory_events WHERE household_id = $1 AND reason <> 'purchase'`, [kitchen.householdId]),
    );
    expect(events.rowCount).toBe(0);
  });

  it('scales the plan to the requested servings', async () => {
    await stockKitchen(kitchen, { ...PASTA_STOCK, scallion: 4 });
    const out = (await start({ recipe_name: 'creamy spinach pasta', servings: 2 })).structuredContent as unknown as Started;
    const row = await session(out.session_id);
    expect(row.planned_usage).toContainEqual({ item_id: kitchen.items.pasta, quantity: 200, status: 'planned', origin: 'recipe' });
  });

  it('asks for a substitution when exactly the substitute is in stock, and starts with it (D2, I1, R28)', async () => {
    await stockKitchen(kitchen, { ...PASTA_STOCK, onion: 2 });
    const question = await start({ recipe_name: 'creamy spinach pasta' });
    expect(parseErrorResult(question)).toMatchObject({
      code: 'substitution_required',
      from_item: 'scallion',
      options: ['onion'],
      ask: 'Use onion instead of scallion?',
    });

    const res = await start({ recipe_name: 'creamy spinach pasta', substitutions: [{ from_item: 'scallions', to_item: 'onion' }] });
    const out = res.structuredContent as unknown as Started;
    expect(out.applied_substitutions).toEqual([{ from_item: 'scallion', to_item: 'onion', quantity: 1 }]);
    const row = await session(out.session_id);
    expect(row.planned_usage).toContainEqual({
      item_id: kitchen.items.onion,
      quantity: 1,
      status: 'planned',
      origin: 'substitute',
      replaces_item_id: kitchen.items.scallion,
    });
  });

  it('rejects a substitution the recipe does not define, or one stock cannot cover (R28)', async () => {
    await stockKitchen(kitchen, { ...PASTA_STOCK, scallion: 4, onion: 0.5 });
    const notDefined = await start({ recipe_name: 'creamy spinach pasta', substitutions: [{ from_item: 'scallion', to_item: 'garlic' }] });
    expect(parseErrorResult(notDefined)).toMatchObject({ code: 'invalid_substitution', options: ['onion'] });
    const notInRecipe = await start({ recipe_name: 'creamy spinach pasta', substitutions: [{ from_item: 'egg', to_item: 'onion' }] });
    expect(parseErrorResult(notInRecipe)?.code).toBe('invalid_substitution');
    const unknownItem = await start({ recipe_name: 'creamy spinach pasta', substitutions: [{ from_item: 'scallion', to_item: 'unobtainium' }] });
    expect(parseErrorResult(unknownItem)?.code).toBe('invalid_substitution');
    const tooLittle = await start({ recipe_name: 'creamy spinach pasta', substitutions: [{ from_item: 'scallion', to_item: 'onion' }] });
    expect(parseErrorResult(tooLittle)).toMatchObject({
      code: 'insufficient_stock',
      shortfall: [{ item: 'onion', need: 1, have: 0.5, unit: 'count' }],
    });
  });

  it('reports what is missing when the recipe cannot be made', async () => {
    await stockKitchen(kitchen, { pasta: 100 });
    const res = await start({ recipe_name: 'creamy spinach pasta' });
    expect(parseErrorResult(res)).toMatchObject({ code: 'insufficient_stock' });
    expect((parseErrorResult(res)?.shortfall as Array<{ item: string }>).map((s) => s.item).sort()).toEqual([
      'butter', 'garlic clove', 'milk', 'pasta', 'scallion', 'spinach',
    ]);
  });

  it('skips a missing optional ingredient automatically', async () => {
    await stockKitchen(kitchen, { pasta: 500, spinach: 300, milk: 1000, 'garlic clove': 5, butter: 100, scallion: 4 });
    const out = (await start({ recipe_name: 'creamy spinach pasta' })).structuredContent as unknown as Started;
    const row = await session(out.session_id);
    expect(row.planned_usage).toContainEqual({ item_id: kitchen.items.parmesan, quantity: 40, status: 'skipped', origin: 'recipe' });
  });

  it('lists the known recipes for an unknown name', async () => {
    const res = await start({ recipe_name: 'beef wellington' });
    expect(parseErrorResult(res)).toMatchObject({ code: 'unknown_recipe' });
    expect(parseErrorResult(res)?.options).toHaveLength(5);
  });

  it('allows one active session per household and asks what to do with it (D1, I6)', async () => {
    await stockKitchen(kitchen, { ...PASTA_STOCK, scallion: 4, egg: 6, tomato: 4, 'olive oil': 100 });
    const first = (await start({ recipe_name: 'creamy spinach pasta' })).structuredContent as unknown as Started;
    const second = await start({ recipe_name: 'tomato egg stir-fry' });
    expect(parseErrorResult(second)).toMatchObject({
      code: 'session_in_progress',
      ask: 'Cancel creamy spinach pasta, or keep going with it?',
      options: ['cancel the current recipe', 'keep going'],
      session_id: first.session_id,
    });
  });

  it('lets exactly one of two concurrent starts win', async () => {
    await stockKitchen(kitchen, { ...PASTA_STOCK, scallion: 4, egg: 6, tomato: 4, 'olive oil': 100 });
    const results = await Promise.all([
      start({ recipe_name: 'creamy spinach pasta' }),
      start({ recipe_name: 'tomato egg stir-fry' }),
    ]);
    const errors = results.map(parseErrorResult);
    expect(errors.filter((e) => e === null)).toHaveLength(1);
    expect(errors.find((e) => e !== null)?.code).toBe('session_in_progress');
  });

  it('returns the same session for a retried request', async () => {
    await stockKitchen(kitchen, { ...PASTA_STOCK, scallion: 4 });
    const ids = { requestId: randomUUID(), conversationId: randomUUID() };
    const first = await start({ recipe_name: 'creamy spinach pasta' }, ids);
    expect(await start({ recipe_name: 'creamy spinach pasta' }, ids)).toEqual(first);
  });

  describe('get_session', () => {
    it('describes the active session with coverage of the planned items', async () => {
      await stockKitchen(kitchen, { ...PASTA_STOCK, scallion: 4 });
      const started = (await start({ recipe_name: 'creamy spinach pasta' })).structuredContent as unknown as Started;
      // Another conversation used milk meanwhile: coverage now shows the shortfall.
      await withAdmin((admin) =>
        admin.query(`UPDATE pantry.batches SET quantity = 100 WHERE item_id = $1`, [kitchen.items.milk]),
      );
      const res = await client.callTool({ name: 'get_session', arguments: {} });
      const out = res.structuredContent as Record<string, unknown>;
      expect(out).toMatchObject({
        session_id: started.session_id,
        recipe: 'creamy spinach pasta',
        state: 'cooking',
        current_step: 1,
        step_no: 1,
        total_steps: 6,
        effective_usage: null,
      });
      expect(out.planned_usage).toContainEqual({ item: 'milk', quantity: 250, unit: 'ml', status: 'planned', origin: 'recipe', replaces: null });
      expect(out.plan_coverage).toContainEqual({ item: 'milk', planned: 250, available: 100, short: 150 });
      expect(out.plan_coverage).toContainEqual({ item: 'pasta', planned: 300, available: 500, short: 0 });
    });

    it('falls back to the most recent session, and errors when there is none', async () => {
      expect(parseErrorResult(await client.callTool({ name: 'get_session', arguments: {} }))?.code).toBe('no_active_session');
      await stockKitchen(kitchen, { ...PASTA_STOCK, scallion: 4 });
      const started = (await start({ recipe_name: 'creamy spinach pasta' })).structuredContent as unknown as Started;
      await withAdmin((admin) =>
        admin.query(`UPDATE pantry.cooking_sessions SET state = 'cancelled' WHERE id = $1`, [started.session_id]),
      );
      const out = (await client.callTool({ name: 'get_session', arguments: {} })).structuredContent as Record<string, unknown>;
      expect(out).toMatchObject({ session_id: started.session_id, state: 'cancelled' });
    });

    it('does not show another household’s session, even by id (I9)', async () => {
      const other = await createDemoKitchen();
      await stockKitchen(other, { ...PASTA_STOCK, scallion: 4 });
      const otherClient = await connectMcpClient(servers, other.token);
      const theirs = (await callWrite(otherClient, 'start_cooking', { recipe_name: 'creamy spinach pasta' }))
        .structuredContent as unknown as Started;
      await otherClient.close();

      const res = await client.callTool({ name: 'get_session', arguments: { session_id: theirs.session_id } });
      expect(parseErrorResult(res)?.code).toBe('no_active_session');
    });
  });
});
