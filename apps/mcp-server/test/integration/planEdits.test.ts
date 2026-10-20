// substitute, skip_ingredient and cancel_cooking (story D2, FR-13, §3.1): plan changes only.
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
  PASTA_STOCK,
  startPasta,
  withAdmin,
} from '../../../../test/fixtures.ts';

interface PlanOut {
  session_id: string;
  changed: boolean;
  options?: Array<{ item: string; quantity: number; unit: string }>;
  planned_usage: Array<{ item: string; quantity: number; status: string; origin: string; replaces: string | null }>;
}

describe('plan edits while cooking', () => {
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
    await client.listTools();
    return () => client.close();
  });

  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await callWrite(client, name, args);
    return { res, out: res.structuredContent as unknown as PlanOut, error: parseErrorResult(res) };
  };
  const sessionRow = async (id: string) =>
    withAdmin(async (admin) =>
      (await admin.query(`SELECT state, state_version, planned_usage FROM pantry.cooking_sessions WHERE id = $1`, [id])).rows[0],
    );
  const nonPurchaseEvents = async () =>
    withAdmin(async (admin) =>
      Number(
        (
          await admin.query(
            `SELECT count(*) FROM pantry.inventory_events WHERE household_id = $1 AND reason <> 'purchase'`,
            [kitchen.householdId],
          )
        ).rows[0].count,
      ),
    );
  /** A pending consume card for the session, as propose_consumption will create it. */
  const pendingConsumeCard = async (sessionId: string) =>
    withAdmin(async (admin) => {
      const id = randomUUID();
      await admin.query(`UPDATE pantry.cooking_sessions SET state = 'awaiting_confirmation' WHERE id = $1`, [sessionId]);
      await admin.query(
        `INSERT INTO pantry.proposals (id, household_id, conversation_id, kind, subject_key, target_session_id,
                                       input, payload, preconditions, status, expires_at)
         VALUES ($1, $2, $3, 'consume', $4, $5, '{}', '{}', '{}', 'pending', now() + interval '1 hour')`,
        [id, kitchen.householdId, randomUUID(), `consume:session:${sessionId}`, sessionId],
      );
      return id;
    });
  const proposalStatus = async (id: string) =>
    withAdmin(async (admin) => (await admin.query(`SELECT status FROM pantry.proposals WHERE id = $1`, [id])).rows[0].status);

  /** Starts the demo dish, then the scallions run out mid-cook (onions are in stock). */
  const startWithoutScallions = async () => {
    const sessionId = await startPasta(kitchen, client, { ...PASTA_STOCK, onion: 2 });
    await withAdmin((admin) => admin.query(`UPDATE pantry.batches SET quantity = 0, status = 'depleted' WHERE item_id = $1`, [kitchen.items.scallion]));
    return sessionId;
  };

  describe('substitute', () => {
    it('lists in-stock substitutes without changing anything (D2)', async () => {
      const sessionId = await startWithoutScallions();
      const { out } = await call('substitute', { from_item: "scallions" });
      expect(out).toMatchObject({ session_id: sessionId, changed: false, options: [{ item: 'onion', quantity: 1, unit: 'count' }] });
      expect((await sessionRow(sessionId)).state_version).toBe(1);
    });

    it('swaps the planned ingredient and leaves inventory alone (D2, FR-13)', async () => {
      const sessionId = await startWithoutScallions();
      const { out, res } = await call('substitute', { from_item: 'scallion', to_item: 'onion' });
      expect(out.changed).toBe(true);
      expect(out.planned_usage).toContainEqual({ item: 'scallion', quantity: 2, unit: 'count', status: 'skipped', origin: 'recipe', replaces: null });
      expect(out.planned_usage).toContainEqual({ item: 'onion', quantity: 1, unit: 'count', status: 'planned', origin: 'substitute', replaces: 'scallion' });
      expect((res.content as Array<{ text: string }>)[0]?.text).toBe('Using 1 onion instead of scallion; inventory is unchanged.');
      expect(await sessionRow(sessionId)).toMatchObject({ state: 'cooking', state_version: 2 });
      expect(await nonPurchaseEvents()).toBe(0);
    });

    it('is a no-op when the same substitution is applied again', async () => {
      const sessionId = await startWithoutScallions();
      await call('substitute', { from_item: 'scallion', to_item: 'onion' });
      const { out } = await call('substitute', { from_item: 'scallion', to_item: 'onion' });
      expect(out.changed).toBe(false);
      expect((await sessionRow(sessionId)).state_version).toBe(2);
    });

    it('refuses substitutes the recipe does not allow, ones not in stock, and unknown ingredients', async () => {
      await startWithoutScallions();
      expect((await call('substitute', { from_item: 'scallion', to_item: 'garlic' })).error).toMatchObject({
        code: 'invalid_substitution',
        options: ['onion'],
      });
      expect((await call('substitute', { from_item: 'egg' })).error?.code).toBe('not_in_plan');
      expect((await call('substitute', { from_item: 'unobtainium' })).error?.code).toBe('not_in_plan');
      await withAdmin((admin) => admin.query(`UPDATE pantry.batches SET quantity = 0, status = 'depleted' WHERE item_id = $1`, [kitchen.items.onion]));
      expect((await call('substitute', { from_item: 'scallion', to_item: 'onion' })).error?.code).toBe('insufficient_stock');
      expect((await call('substitute', { from_item: 'scallion' })).error).toMatchObject({
        code: 'no_substitute',
        options: ['skip it', 'add it to the shopping list'],
      });
    });

    it('returns an awaiting session to cooking and supersedes its waiting card (§3.1)', async () => {
      const sessionId = await startWithoutScallions();
      const card = await pendingConsumeCard(sessionId);
      await call('substitute', { from_item: 'scallion', to_item: 'onion' });
      expect((await sessionRow(sessionId)).state).toBe('cooking');
      expect(await proposalStatus(card)).toBe('superseded');
    });
  });

  describe('skip_ingredient', () => {
    it('skips an optional ingredient directly', async () => {
      const sessionId = await startPasta(kitchen, client);
      const { out } = await call('skip_ingredient', { item: 'parmesan' });
      expect(out.changed).toBe(true);
      expect(out.planned_usage).toContainEqual(expect.objectContaining({ item: 'parmesan', status: 'skipped' }));
      expect((await sessionRow(sessionId)).state_version).toBe(2);
      expect((await call('skip_ingredient', { item: 'parmesan' })).out.changed).toBe(false);
    });

    it('asks before skipping a required ingredient, and skips once confirmed', async () => {
      await startPasta(kitchen, client);
      expect((await call('skip_ingredient', { item: 'garlic' })).error).toEqual({
        code: 'needs_clarification',
        message: 'garlic is needed for this recipe.',
        ask: 'Cook without the garlic anyway?',
        required: ['confirm_skip'],
      });
      const { out } = await call('skip_ingredient', { item: 'garlic', confirm_skip: true });
      expect(out.planned_usage).toContainEqual(expect.objectContaining({ item: 'garlic', status: 'skipped' }));
    });

    it('treats a substitute like the ingredient it replaces', async () => {
      await startWithoutScallions();
      await call('substitute', { from_item: 'scallion', to_item: 'onion' });
      expect((await call('skip_ingredient', { item: 'onion' })).error?.code).toBe('needs_clarification');
    });

    it('refuses an item the recipe does not use', async () => {
      await startPasta(kitchen, client);
      expect((await call('skip_ingredient', { item: 'egg' })).error?.code).toBe('not_in_plan');
    });
  });

  describe('cancel_cooking', () => {
    it('cancels the session, supersedes its waiting card, and ends cooking tools', async () => {
      const sessionId = await startPasta(kitchen, client);
      const card = await pendingConsumeCard(sessionId);
      const { out } = await call('cancel_cooking', {});
      expect(out).toEqual({ session_id: sessionId, recipe: 'creamy spinach pasta', state: 'cancelled' });
      expect(await sessionRow(sessionId)).toMatchObject({ state: 'cancelled', state_version: 2 });
      expect(await proposalStatus(card)).toBe('superseded');
      expect((await call('cancel_cooking', {})).error?.code).toBe('no_active_session');
      expect((await call('next_step', { expected_step: 1 })).error?.code).toBe('no_active_session');
      expect(await nonPurchaseEvents()).toBe(0);
    });
  });
});
