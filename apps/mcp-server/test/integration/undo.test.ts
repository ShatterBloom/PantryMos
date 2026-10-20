// propose_undo and its confirm (§6.6, §4.3): R5, R6 (paths 3a/3b/3c and step 4), R12.
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type RunningServers, startServers } from '../../src/app.ts';
import { parseErrorResult } from '../../src/mcp/toolkit.ts';
import {
  adjustStock,
  callWrite,
  confirmCard,
  connectMcpClient,
  createDemoKitchen,
  type DemoKitchen,
  eatMeal,
  ledgerMismatches,
  mcpTestConfig,
  stockKitchen,
  withAdmin,
} from '../../../../test/fixtures.ts';

interface Proposed {
  proposal_id: string;
  version: number;
  scope: 'operation' | 'session';
  target: string;
  card: { title: string; lines: string[]; readback_text: string };
}

describe('propose_undo', () => {
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
    // Everything the stir-fry needs except eggs, which each test adds through a real intake.
    await stockKitchen(kitchen, { tomato: 4, 'olive oil': 100, scallion: 2 });
    return () => client.close();
  });

  const undo = (args: Record<string, unknown>) => callWrite(client, 'propose_undo', args);
  const ok = async (args: Record<string, unknown>) => {
    const res = await undo(args);
    expect(parseErrorResult(res)).toBeNull();
    return res.structuredContent as unknown as Proposed;
  };
  const undoAndConfirm = async (args: Record<string, unknown>) => {
    const p = await ok(args);
    const res = await confirmCard(servers, p, p.version);
    expect(res.status).toBe(200);
    return res;
  };
  const eggs = async () =>
    withAdmin(async (admin) =>
      Number(
        (
          await admin.query(`SELECT COALESCE(sum(quantity), 0) AS n FROM pantry.batches WHERE household_id = $1 AND item_id = $2`, [
            kitchen.householdId,
            kitchen.items.egg,
          ])
        ).rows[0].n,
      ),
    );
  const sessionState = async (id: string) =>
    withAdmin(async (admin) => (await admin.query(`SELECT state FROM pantry.cooking_sessions WHERE id = $1`, [id])).rows[0].state);

  /** §6.6 worked example, steps 0–2: intake 12, consume 2, revise to 3. */
  const workedExample = async () => {
    const intake = (await callWrite(client, 'propose_intake', { items: [{ name: 'egg', quantity: 12 }] })).structuredContent as {
      proposal_id: string;
    };
    const intakeOp = (await confirmCard(servers, intake, 1)).body.operation_id as string;
    expect(await eggs()).toBe(12);
    const meal = await eatMeal(servers, client, 'tomato egg stir-fry', [{ item: 'egg', quantity: 2 }]);
    expect(await eggs()).toBe(10);
    const revision = (await callWrite(client, 'propose_consumption_revision', { usage: [{ item: 'egg', quantity: 3 }] }))
      .structuredContent as { proposal_id: string };
    const revisionOp = (await confirmCard(servers, revision, 1)).body.operation_id as string;
    expect(await eggs()).toBe(9);
    return { intakeOp, revisionOp, ...meal };
  };

  describe('the worked example (R6)', () => {
    it('3a: undoing just the correction puts back 1 egg; the meal stays consumed', async () => {
      const { revisionOp, sessionId } = await workedExample();
      const asked = parseErrorResult(await undo({ target: 'last' }));
      expect(asked).toMatchObject({ code: 'ambiguous_undo', ask: 'Undo just the correction, or the whole tomato egg stir-fry?' });

      const p = await ok({ target: 'last', scope: 'operation' });
      expect(p).toMatchObject({ scope: 'operation', target: revisionOp });
      expect(p.card.title).toBe('Undo the correction to tomato egg stir-fry');
      expect(p.card.readback_text).toBe(
        "I'll undo the correction to tomato egg stir-fry, putting back 1 egg. Say confirm, or tell me what to change.",
      );
      expect((await confirmCard(servers, p, 1)).status).toBe(200);
      expect(await eggs()).toBe(10);
      expect(await sessionState(sessionId)).toBe('consumed');
    });

    it('3b: undoing the whole meal puts back 3 eggs and reverts the session', async () => {
      const { sessionId, operationId, revisionOp } = await workedExample();
      const p = await ok({ target: 'last', scope: 'session' });
      expect(p).toMatchObject({ scope: 'session', target: sessionId });
      expect(p.card.readback_text).toBe(
        "I'll undo the whole tomato egg stir-fry meal, putting back 3 eggs, 15 milliliters of olive oil, 1 scallion and 2 tomatoes. " +
          'Say confirm, or tell me what to change.',
      );
      const res = await confirmCard(servers, p, 1);
      expect(res.body).toMatchObject({ kind: 'undo', summary: { scope: 'session', target: sessionId } });
      expect((res.body.summary as { reverted_operations: string[] }).reverted_operations.sort()).toEqual([operationId, revisionOp].sort());

      expect(await eggs()).toBe(12);
      expect(await sessionState(sessionId)).toBe('reverted');
      const reverted = await withAdmin(async (admin) =>
        (await admin.query(`SELECT id FROM pantry.operations WHERE reverted_by_op = $1 ORDER BY id`, [res.body.operation_id])).rows,
      );
      expect(reverted.map((r) => r.id)).toEqual([operationId, revisionOp].sort());
      const usage = await client.callTool({ name: 'get_session', arguments: { session_id: sessionId } });
      expect((usage.structuredContent as { effective_usage: unknown[] }).effective_usage).toContainEqual({ item: 'egg', quantity: 0, unit: 'count' });
    });

    it('3c: undoing the whole meal after the correction was undone puts back the 2 eggs left', async () => {
      const { sessionId } = await workedExample();
      await undoAndConfirm({ target: 'last', scope: 'operation' });
      expect(await eggs()).toBe(10);
      // The correction is reverted, so "last" is now the meal's consume: it undoes the meal.
      const p = await ok({ target: 'last' });
      expect(p).toMatchObject({ scope: 'session', target: sessionId });
      expect(p.card.readback_text).toMatch(/, putting back 2 eggs, 15 milliliters of olive oil, /);
      expect((await confirmCard(servers, p, 1)).status).toBe(200);
      expect(await eggs()).toBe(12);
      expect(await ledgerMismatches(kitchen.householdId)).toEqual([]);
    });

    it('4: undoing the intake after 3b takes the 12 eggs back off', async () => {
      const { intakeOp } = await workedExample();
      await undoAndConfirm({ target: 'last', scope: 'session' });
      const p = await ok({ target: intakeOp });
      expect(p.card).toMatchObject({ title: 'Undo the groceries added', lines: [expect.stringMatching(/^−12 eggs · /)] });
      expect((await confirmCard(servers, p, 1)).status).toBe(200);
      expect(await eggs()).toBe(0);
      expect(await ledgerMismatches(kitchen.householdId)).toEqual([]);
    });
  });

  it('refuses to undo an intake some of which was used since (R12)', async () => {
    const { intakeOp } = await workedExample();
    expect(parseErrorResult(await undo({ target: intakeOp }))).toMatchObject({
      code: 'would_go_negative',
      options: ['adjust the stock instead'],
    });
  });

  it('makes a pinned correction stale once the whole meal was undone (R5)', async () => {
    const intake = (await callWrite(client, 'propose_intake', { items: [{ name: 'egg', quantity: 12 }] })).structuredContent as {
      proposal_id: string;
    };
    await confirmCard(servers, intake, 1);
    await eatMeal(servers, client, 'tomato egg stir-fry', [{ item: 'egg', quantity: 2 }]);
    const revision = (await callWrite(client, 'propose_consumption_revision', { usage: [{ item: 'egg', quantity: 3 }] }))
      .structuredContent as { proposal_id: string };
    await undoAndConfirm({ target: 'last' }); // the meal (the correction is not confirmed)
    expect(await eggs()).toBe(12);

    expect(await confirmCard(servers, revision, 1)).toMatchObject({ status: 409, body: { code: 'stale_state', reason: 'session_changed' } });
    expect(await eggs()).toBe(12);
    const outcome = await withAdmin(async (admin) =>
      (await admin.query(`SELECT outcome FROM pantry.confirmations WHERE proposal_id = $1`, [revision.proposal_id])).rows,
    );
    expect(outcome).toEqual([{ outcome: 'stale' }]);
  });

  it('asks to undo the whole meal when its consume has live corrections', async () => {
    const { operationId, sessionId } = await workedExample();
    expect(parseErrorResult(await undo({ target: operationId, scope: 'operation' }))).toMatchObject({
      code: 'has_dependents',
      options: [{ scope: 'session', target: sessionId, label: 'undo the whole meal' }],
    });
    // Without a scope, the consume undoes the meal; a session id does the same.
    expect(await ok({ target: operationId })).toMatchObject({ scope: 'session', target: sessionId });
    expect(await ok({ target: sessionId })).toMatchObject({ scope: 'session', target: sessionId });
  });

  it('undoes a discard and makes the batch active again', async () => {
    const egg = (await stockKitchen(kitchen, { egg: 6 })).egg!;
    expect((await adjustStock(servers, client, { batch_id: egg, delta: -6, reason: 'discard' })).status).toBe(200);
    const p = await ok({ target: 'last' });
    expect(p.card.title).toBe('Undo the stock adjustment');
    expect((await confirmCard(servers, p, 1)).status).toBe(200);
    const row = await withAdmin(async (admin) =>
      (await admin.query(`SELECT quantity::float AS quantity, status FROM pantry.batches WHERE id = $1`, [egg])).rows[0],
    );
    expect(row).toEqual({ quantity: 6, status: 'active' });
  });

  it('says there is nothing to undo in a kitchen with no history', async () => {
    const empty = await createDemoKitchen();
    const emptyClient = await connectMcpClient(servers, empty.token);
    try {
      const res = await callWrite(emptyClient, 'propose_undo', { target: 'last' });
      expect(parseErrorResult(res)).toMatchObject({ code: 'not_undoable', message: 'There is nothing to undo.' });
    } finally {
      await emptyClient.close();
    }
  });

  it('refuses what cannot be undone', async () => {
    const { intakeOp, revisionOp, sessionId } = await workedExample();

    const done = await undoAndConfirm({ target: revisionOp });
    expect(parseErrorResult(await undo({ target: revisionOp }))?.code).toBe('already_reverted');
    expect(parseErrorResult(await undo({ target: done.body.operation_id as string }))?.code).toBe('not_undoable');
    expect(parseErrorResult(await undo({ target: intakeOp, scope: 'session' }))?.code).toBe('not_undoable');
    expect(parseErrorResult(await undo({ target: '00000000-0000-4000-8000-000000000000' }))?.code).toBe('not_found');

    await undoAndConfirm({ target: sessionId });
    expect(parseErrorResult(await undo({ target: sessionId }))?.code).toBe('already_reverted');

    const cooking = (await callWrite(client, 'start_cooking', { recipe_name: 'tomato egg stir-fry' })).structuredContent as {
      session_id: string;
    };
    expect(parseErrorResult(await undo({ target: cooking.session_id }))).toMatchObject({ code: 'invalid_state', state: 'cooking' });
  });

  it('marks the undone operation reverted in the recent list', async () => {
    const { revisionOp } = await workedExample();
    await undoAndConfirm({ target: revisionOp });
    const res = await client.callTool({ name: 'list_recent_operations', arguments: { limit: 2 } });
    const ops = (res.structuredContent as { operations: Array<{ operation_id: string; kind: string; reverted: boolean }> }).operations;
    expect(ops[0]).toMatchObject({ kind: 'undo', reverted: false });
    expect(ops[1]).toMatchObject({ operation_id: revisionOp, reverted: true });
  });
});
