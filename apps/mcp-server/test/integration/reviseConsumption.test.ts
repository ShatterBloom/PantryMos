// propose_consumption_revision and its confirm (§6.5, §4.3): R7, R8b, R13–R15.
import { randomUUID } from 'node:crypto';
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
  internalCall,
  ledgerMismatches,
  mcpTestConfig,
  stockKitchen,
  withAdmin,
} from '../../../../test/fixtures.ts';

interface Revised {
  proposal_id: string;
  version: number;
  session_id: string;
  card: { title: string; lines: string[]; readback_text: string };
}

const STIR_FRY_REST = { tomato: 4, 'olive oil': 100, scallion: 2 };

describe('propose_consumption_revision', () => {
  let servers: RunningServers;
  beforeAll(async () => {
    servers = await startServers(mcpTestConfig(), { log: false });
  });
  afterAll(async () => servers.close());

  let kitchen: DemoKitchen;
  let client: Client;
  let eggOld: string;
  let eggNew: string;
  beforeEach(async () => {
    kitchen = await createDemoKitchen();
    client = await connectMcpClient(servers, kitchen.token);
    // The older carton is used first (FEFO): it has 6 eggs, the newer one 12.
    eggOld = (await stockKitchen(kitchen, { egg: 6 }, 10)).egg!;
    eggNew = (await stockKitchen(kitchen, { egg: 12, ...STIR_FRY_REST }, 1)).egg!;
    return () => client.close();
  });

  const revise = (args: Record<string, unknown>) => callWrite(client, 'propose_consumption_revision', args);
  const ok = async (args: Record<string, unknown>) => {
    const res = await revise(args);
    expect(parseErrorResult(res)).toBeNull();
    return res.structuredContent as unknown as Revised;
  };
  const stored = async (proposalId: string) =>
    withAdmin(async (admin) => (await admin.query(`SELECT * FROM pantry.proposals WHERE id = $1`, [proposalId])).rows[0]);
  const quantity = async (batchId: string) =>
    withAdmin(async (admin) =>
      (await admin.query(`SELECT quantity::float AS quantity, status FROM pantry.batches WHERE id = $1`, [batchId])).rows[0],
    );
  const stirFry = () => eatMeal(servers, client, 'tomato egg stir-fry'); // 3 eggs, 2 tomatoes, 15 ml oil, 1 scallion

  describe('proposing', () => {
    it('finds the meal without an active session and changes only the listed item (R14, R15)', async () => {
      const { sessionId } = await stirFry();
      const p = await ok({ usage: [{ item: 'eggs', quantity: 4 }] });

      expect(p.session_id).toBe(sessionId);
      expect(p.card.title).toBe('Correct tomato egg stir-fry');
      expect(p.card.lines).toEqual([
        'egg: 3 → 4 (+1)',
        'olive oil: 15 ml (unchanged)',
        'scallion: 1 (unchanged)',
        'tomato: 2 (unchanged)',
        expect.stringMatching(/^take 1 egg · stored for 10 days/),
      ]);
      expect(p.card.readback_text).toBe('For tomato egg stir-fry, I\'ll record 4 eggs instead of 3. Say confirm, or tell me what to change.');
      const row = await stored(p.proposal_id);
      expect(row).toMatchObject({
        kind: 'revise_consumption',
        subject_key: `revise:session:${sessionId}`,
        target_session_id: sessionId,
        input: { session_id: sessionId, usage: [{ item: 'eggs', quantity: 4 }] },
        preconditions: { session: { id: sessionId, state: 'consumed' }, batches: [{ id: eggOld }] },
      });
      expect(await quantity(eggOld)).toEqual({ quantity: 3, status: 'active' }); // nothing deducted yet
    });

    it('plans a lower total as a return to the batch the meal took it from (R7)', async () => {
      await stirFry();
      const p = await ok({ usage: [{ item: 'egg', quantity: 1 }, { item: 'tomato', quantity: 2 }] });
      expect(p.card.lines).toContain('egg: 3 → 1 (−2)');
      expect(p.card.lines).toContain('tomato: 2 (unchanged)');
      expect(p.card.lines.at(-1)).toMatch(/^put back 2 eggs · stored for 10 days/);
      expect((await stored(p.proposal_id)).payload.allocation).toEqual([{ batch_id: eggOld, item_id: kitchen.items.egg, delta: 2 }]);
    });

    it('adds an item the meal did not record, and ignores one set to 0 that it never used', async () => {
      await stockKitchen(kitchen, { milk: 1000 });
      await stirFry();
      const p = await ok({ usage: [{ item: 'milk', quantity: 50 }, { item: 'pasta', quantity: 0 }] });
      expect(p.card.lines).toContain('milk: 0 → 50 ml (+50)');
      expect(p.card.lines.some((l) => l.startsWith('pasta'))).toBe(false);
    });

    it('returns the same version for the same correction and a new one for a different correction (R23)', async () => {
      await stirFry();
      const first = await ok({ usage: [{ item: 'egg', quantity: 4 }] });
      const same = await ok({ usage: [{ item: 'egg', quantity: 4 }] });
      expect(same).toMatchObject({ proposal_id: first.proposal_id, version: 1 });
      const changed = await ok({ usage: [{ item: 'egg', quantity: 5 }] });
      expect(changed).toMatchObject({ proposal_id: first.proposal_id, version: 2 });
    });

    it('says when the correction matches what was recorded', async () => {
      await stirFry();
      const p = await ok({ usage: [{ item: 'egg', quantity: 3 }] });
      expect(p.card.readback_text).toMatch(/^That matches what was recorded for tomato egg stir-fry, so nothing changes\./);
      expect((await stored(p.proposal_id)).payload.allocation).toEqual([]);
    });

    it('asks which meal when two were recorded in the last 24 hours, and accepts a recipe name or session id (R13)', async () => {
      await stockKitchen(kitchen, { spinach: 100, milk: 100, butter: 50, ...STIR_FRY_REST });
      const stir = await stirFry();
      const omelette = await eatMeal(servers, client, 'spinach omelette');

      const ambiguous = parseErrorResult(await revise({ usage: [{ item: 'egg', quantity: 1 }] }));
      expect(ambiguous).toMatchObject({ code: 'ambiguous_session', ask: 'Which meal do you mean?' });
      expect((ambiguous!.options as Array<{ session_id: string }>).map((o) => o.session_id)).toEqual([
        omelette.sessionId,
        stir.sessionId,
      ]);

      expect((await ok({ usage: [{ item: 'egg', quantity: 1 }], recipe_name: 'tomato and egg stir-fry' })).session_id).toBe(stir.sessionId);
      expect((await ok({ usage: [{ item: 'egg', quantity: 1 }], session_id: omelette.sessionId })).session_id).toBe(omelette.sessionId);
    });

    it('finds no meal when none was recorded in the last 24 hours, or none of that recipe', async () => {
      expect(parseErrorResult(await revise({ usage: [{ item: 'egg', quantity: 1 }] }))?.code).toBe('no_completed_session');
      const { sessionId } = await stirFry();
      expect(parseErrorResult(await revise({ usage: [{ item: 'egg', quantity: 1 }], recipe_name: 'potato soup' }))).toMatchObject({
        code: 'no_completed_session',
        message: 'No potato soup was recorded in the last 24 hours.',
      });
      expect(parseErrorResult(await revise({ usage: [{ item: 'egg', quantity: 1 }], recipe_name: 'lasagne' }))?.code).toBe('unknown_recipe');

      await withAdmin((admin) =>
        admin.query(`UPDATE pantry.cooking_sessions SET consumed_at = now() - interval '25 hours' WHERE id = $1`, [sessionId]),
      );
      expect(parseErrorResult(await revise({ usage: [{ item: 'egg', quantity: 1 }] }))?.code).toBe('no_completed_session');
      // An older meal can still be corrected by id.
      expect((await ok({ usage: [{ item: 'egg', quantity: 1 }], session_id: sessionId })).session_id).toBe(sessionId);
    });

    it('refuses a session that is not a finished meal, unknown items and more than the stock', async () => {
      const cooking = (await callWrite(client, 'start_cooking', { recipe_name: 'tomato egg stir-fry' })).structuredContent as {
        session_id: string;
      };
      expect(parseErrorResult(await revise({ usage: [{ item: 'egg', quantity: 1 }], session_id: cooking.session_id }))).toMatchObject({
        code: 'invalid_state',
        state: 'cooking',
      });
      expect(
        parseErrorResult(await revise({ usage: [{ item: 'egg', quantity: 1 }], session_id: '00000000-0000-4000-8000-000000000000' }))
          ?.code,
      ).toBe('no_completed_session');
      await callWrite(client, 'cancel_cooking', {});

      await stirFry();
      expect(parseErrorResult(await revise({ usage: [{ item: 'unobtainium', quantity: 1 }] }))?.code).toBe('unknown_item');
      expect(parseErrorResult(await revise({ usage: [{ item: 'egg', quantity: 100 }] }))).toMatchObject({
        code: 'insufficient_stock',
        item: 'egg',
      });
      expect(parseErrorResult(await revise({ usage: [{ item: 'egg', quantity: 0.0001 }] }))?.code).toBe('invalid_quantity');
    });
  });

  describe('confirming', () => {
    const sessionRow = async (id: string) =>
      withAdmin(async (admin) =>
        (await admin.query(`SELECT state, state_version FROM pantry.cooking_sessions WHERE id = $1`, [id])).rows[0],
      );
    const effective = async () => {
      const res = await client.callTool({ name: 'get_session', arguments: {} });
      return (res.structuredContent as { effective_usage: Array<{ item: string; quantity: number }> }).effective_usage;
    };

    it('takes the extra amount as a revision event of the meal and bumps the session version', async () => {
      const { sessionId } = await stirFry();
      const before = await sessionRow(sessionId);
      const p = await ok({ usage: [{ item: 'egg', quantity: 4 }] });
      const res = await confirmCard(servers, p, 1);

      expect(res).toMatchObject({
        status: 200,
        body: { kind: 'revise_consumption', summary: { session_id: sessionId, lines: [{ item: 'egg', from: 3, to: 4, unit: 'count' }] } },
      });
      expect(await quantity(eggOld)).toEqual({ quantity: 2, status: 'active' });
      expect(await sessionRow(sessionId)).toEqual({ state: 'consumed', state_version: before.state_version + 1 });
      expect(await effective()).toContainEqual({ item: 'egg', quantity: 4, unit: 'count' });
      const events = await withAdmin(async (admin) =>
        (
          await admin.query(
            `SELECT batch_id, delta::float AS delta, session_id FROM pantry.inventory_events WHERE reason = 'consume_revision' AND household_id = $1`,
            [kitchen.householdId],
          )
        ).rows,
      );
      expect(events).toEqual([{ batch_id: eggOld, delta: -1, session_id: sessionId }]);
      expect(await ledgerMismatches(kitchen.householdId)).toEqual([]);
    });

    it('returns stock to a batch the meal emptied, which becomes active again (R7)', async () => {
      expect((await adjustStock(servers, client, { batch_id: eggNew, delta: -12, reason: 'discard' })).status).toBe(200);
      // Only the 6-egg carton is active; two meals of 3 eggs empty it.
      await stockKitchen(kitchen, STIR_FRY_REST);
      await stirFry();
      const second = await stirFry();
      expect(await quantity(eggOld)).toEqual({ quantity: 0, status: 'depleted' });

      const p = await ok({ usage: [{ item: 'egg', quantity: 1 }], session_id: second.sessionId });
      expect((await confirmCard(servers, p, 1)).status).toBe(200);
      expect(await quantity(eggOld)).toEqual({ quantity: 2, status: 'active' });
      expect(await ledgerMismatches(kitchen.householdId)).toEqual([]);
    });

    it('returns to the batch the meal took from most recently first, each up to what it gave', async () => {
      await stockKitchen(kitchen, STIR_FRY_REST);
      await eatMeal(servers, client, 'tomato egg stir-fry', [{ item: 'egg', quantity: 4 }]); // old carton: 2 left
      const { sessionId } = await stirFry(); // 2 from the old carton, 1 from the new one
      const more = await ok({ usage: [{ item: 'egg', quantity: 5 }], session_id: sessionId }); // +2 from the new one
      expect((await confirmCard(servers, more, 1)).status).toBe(200);
      expect(await quantity(eggNew)).toEqual({ quantity: 9, status: 'active' });

      const less = await ok({ usage: [{ item: 'egg', quantity: 1 }], session_id: sessionId }); // give 4 back
      expect((await stored(less.proposal_id)).payload.allocation).toEqual([
        { batch_id: eggNew, item_id: kitchen.items.egg, delta: 3 },
        { batch_id: eggOld, item_id: kitchen.items.egg, delta: 1 },
      ]);
      expect((await confirmCard(servers, less, 1)).status).toBe(200);
      expect(await quantity(eggNew)).toEqual({ quantity: 12, status: 'active' });
      expect(await quantity(eggOld)).toEqual({ quantity: 1, status: 'active' });
      expect(await ledgerMismatches(kitchen.householdId)).toEqual([]);
    });

    it('is stale when the meal changed after the card was made', async () => {
      const { sessionId } = await stirFry();
      const p = await ok({ usage: [{ item: 'egg', quantity: 4 }] });
      await withAdmin((admin) =>
        admin.query(`UPDATE pantry.cooking_sessions SET state_version = state_version + 1 WHERE id = $1`, [sessionId]),
      );
      expect(await confirmCard(servers, p, 1)).toMatchObject({ status: 409, body: { code: 'stale_state', reason: 'session_changed' } });
      expect(await quantity(eggOld)).toEqual({ quantity: 3, status: 'active' });

      // Refresh re-plans the same meal from today's state.
      const refreshed = await internalCall(servers, `/internal/proposals/${p.proposal_id}/regenerate`, {
        request_id: randomUUID(),
      });
      expect(refreshed).toMatchObject({ status: 200, body: { kind: 'revise_consumption', version: 1 } });
      expect((await confirmCard(servers, refreshed.body as { proposal_id: string }, 1)).status).toBe(200);
      expect(await quantity(eggOld)).toEqual({ quantity: 2, status: 'active' });
    });

    it('applies a card edit on top of the earlier correction', async () => {
      await stirFry();
      const p = await ok({ usage: [{ item: 'egg', quantity: 4 }] });
      const edited = await internalCall(
        servers,
        `/internal/proposals/${p.proposal_id}`,
        { base_version: 1, changes: { usage: [{ item: 'tomato', quantity: 1 }] }, request_id: randomUUID() },
        'PATCH',
      );
      expect(edited).toMatchObject({ status: 200, body: { version: 2, outcome: 'new_version' } });
      expect((await stored(p.proposal_id)).input.usage).toEqual([
        { item: 'egg', quantity: 4 },
        { item: 'tomato', quantity: 1 },
      ]);
    });

    it('commits exactly one of two concurrent revisions of different meals that pin the same batch (R8b)', async () => {
      await stockKitchen(kitchen, STIR_FRY_REST);
      const a = await stirFry();
      const b = await stirFry();
      const revA = await ok({ usage: [{ item: 'egg', quantity: 4 }], session_id: a.sessionId });
      const revB = await ok({ usage: [{ item: 'egg', quantity: 4 }], session_id: b.sessionId });
      expect((await stored(revA.proposal_id)).preconditions.batches).toEqual((await stored(revB.proposal_id)).preconditions.batches);

      const results = await Promise.all([confirmCard(servers, revA, 1), confirmCard(servers, revB, 1)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(results.find((r) => r.status === 409)!.body).toMatchObject({ code: 'stale_state', reason: 'batch_changed' });
      // Both meals emptied the old carton, so both corrections take their extra egg from the new one.
      expect(await quantity(eggNew)).toEqual({ quantity: 11, status: 'active' });
      expect(await ledgerMismatches(kitchen.householdId)).toEqual([]);
    });
  });
});
