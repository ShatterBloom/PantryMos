// Confirming consumption cards (§4.3): R1–R4, R16, R20, and a confirm racing a batch change (R8a).
import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type RunningServers, startServers } from '../../src/app.ts';
import { addDays } from '../../src/domain/dates.ts';
import { parseErrorResult } from '../../src/mcp/toolkit.ts';
import { TEST_ADMIN_URL } from '../../../../test/env.ts';
import {
  adjustStock,
  callWrite,
  connectMcpClient,
  createBatch,
  createDemoKitchen,
  type DemoKitchen,
  internalCall,
  ledgerMismatches,
  mcpTestConfig,
  PASTA_STOCK,
  stockKitchen,
  todayIn,
  waitForLockWaiters,
  withAdmin,
} from '../../../../test/fixtures.ts';

interface Proposed {
  proposal_id: string;
  version: number;
}

describe('confirm consumption', () => {
  let servers: RunningServers;
  beforeAll(async () => {
    servers = await startServers(mcpTestConfig(), { log: false });
  });
  afterAll(async () => servers.close());

  let kitchen: DemoKitchen;
  let client: Client;
  let milkA: string;
  let milkB: string;
  let sessionId: string;

  beforeEach(async () => {
    kitchen = await createDemoKitchen();
    client = await connectMcpClient(servers, kitchen.token);
    const today = await todayIn('America/Los_Angeles');
    const { milk: _milk, ...rest } = PASTA_STOCK;
    await stockKitchen(kitchen, rest);
    // Milk A (best by today+2) is used before milk B (today+8).
    milkA = await createBatch(kitchen.householdId, kitchen.items.milk!, {
      quantity: 1000, purchased_at: addDays(today, -3), package_date: addDays(today, 2), package_date_type: 'best_by',
    });
    milkB = await createBatch(kitchen.householdId, kitchen.items.milk!, {
      quantity: 1000, purchased_at: addDays(today, -1), package_date: addDays(today, 8), package_date_type: 'best_by',
    });
    sessionId = ((await callWrite(client, 'start_cooking', { recipe_name: 'creamy spinach pasta' })).structuredContent as {
      session_id: string;
    }).session_id;
    return () => client.close();
  });

  const propose = async (overrides?: Array<{ item: string; quantity: number }>) => {
    const res = await callWrite(client, 'propose_consumption', overrides ? { overrides } : {});
    expect(parseErrorResult(res)).toBeNull();
    return res.structuredContent as unknown as Proposed;
  };
  const confirm = (p: { proposal_id: string }, version: number, extra: Record<string, unknown> = {}) =>
    internalCall(servers, `/internal/proposals/${p.proposal_id}/confirm`, {
      version,
      user_id: 'demo',
      channel: 'ui_click',
      request_id: randomUUID(),
      ...extra,
    });
  const quantity = async (batchId: string) =>
    withAdmin(async (admin) => Number((await admin.query(`SELECT quantity FROM pantry.batches WHERE id = $1`, [batchId])).rows[0].quantity));
  const consumeEvents = async () =>
    withAdmin(async (admin) =>
      (
        await admin.query(
          `SELECT batch_id, delta::float AS delta, session_id FROM pantry.inventory_events
            WHERE household_id = $1 AND reason = 'consume' ORDER BY delta`,
          [kitchen.householdId],
        )
      ).rows,
    );
  const sessionState = async () =>
    withAdmin(async (admin) =>
      (await admin.query(`SELECT state, consumed_at IS NOT NULL AS consumed FROM pantry.cooking_sessions WHERE id = $1`, [sessionId]))
        .rows[0],
    );

  it('deducts the pinned FEFO allocation: one operation, events per batch (R1, D3)', async () => {
    const p = await propose([{ item: 'milk', quantity: 1200 }]);
    const res = await confirm(p, 1);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'committed', kind: 'consume', summary: { session_id: sessionId } });

    expect(await quantity(milkA)).toBe(0);
    expect(await quantity(milkB)).toBe(800);
    const milkEvents = (await consumeEvents()).filter((e) => e.batch_id === milkA || e.batch_id === milkB);
    expect(milkEvents).toEqual([
      { batch_id: milkA, delta: -1000, session_id: sessionId },
      { batch_id: milkB, delta: -200, session_id: sessionId },
    ]);
    const ops = await withAdmin(async (admin) =>
      admin.query(`SELECT session_id FROM pantry.operations WHERE proposal_id = $1`, [p.proposal_id]),
    );
    expect(ops.rows).toEqual([{ session_id: sessionId }]);
    expect(await sessionState()).toEqual({ state: 'consumed', consumed: true });
    const status = await withAdmin(async (admin) =>
      (await admin.query(`SELECT status FROM pantry.batches WHERE id = $1`, [milkA])).rows[0].status,
    );
    expect(status).toBe('depleted'); // I8
    expect(await ledgerMismatches(kitchen.householdId)).toEqual([]);
  });

  it('reports what was used through get_session once consumed (I5)', async () => {
    const p = await propose([{ item: 'milk', quantity: 1200 }]);
    await confirm(p, 1);
    const out = (await client.callTool({ name: 'get_session', arguments: { session_id: sessionId } })).structuredContent as {
      effective_usage: Array<{ item: string; quantity: number }>;
    };
    expect(out.effective_usage).toContainEqual({ item: 'milk', quantity: 1200, unit: 'ml' });
  });

  it('commits once for a repeated request and answers a new one with already_committed (R2, R3)', async () => {
    const p = await propose();
    const body = { version: 1, user_id: 'demo', channel: 'ui_click', request_id: randomUUID() };
    const path = `/internal/proposals/${p.proposal_id}/confirm`;
    const first = await internalCall(servers, path, body);
    expect(await internalCall(servers, path, body)).toEqual(first);
    const again = await confirm(p, 1);
    expect(again).toMatchObject({ status: 409, body: { code: 'already_committed', operation_id: first.body.operation_id } });
    expect((await consumeEvents()).length).toBe(7); // one per planned ingredient, once
  });

  it('refuses an older card version and deducts nothing (R4, E2)', async () => {
    const v1 = await propose();
    await propose([{ item: 'pasta', quantity: 250 }]);
    expect(await confirm(v1, 1)).toMatchObject({ status: 409, body: { code: 'stale_proposal', current_version: 2 } });
    expect(await consumeEvents()).toEqual([]);
    expect((await confirm(v1, 2)).status).toBe(200);
  });

  it('refuses the card of a cancelled session (R16)', async () => {
    const p = await propose();
    await callWrite(client, 'cancel_cooking', {});
    expect(await confirm(p, 1)).toMatchObject({ status: 409, body: { code: 'not_pending', status: 'superseded' } });
    expect(await consumeEvents()).toEqual([]);
  });

  it('rounds an override to the stored precision before the card is made, and refuses one that rounds to zero', async () => {
    const p = await propose([{ item: 'milk', quantity: 0.3333 }]);
    const payload = await withAdmin(async (admin) =>
      (await admin.query(`SELECT input, payload FROM pantry.proposals WHERE id = $1`, [p.proposal_id])).rows[0],
    );
    expect(payload.input.overrides).toEqual([{ item: 'milk', quantity: 0.333 }]);
    expect(payload.payload.lines).toContainEqual(expect.objectContaining({ item: 'milk', quantity: 0.333 }));
    expect((await confirm(p, 1)).status).toBe(200);
    expect(await quantity(milkA)).toBe(999.667);
    expect(await ledgerMismatches(kitchen.householdId)).toEqual([]);

    await stockKitchen(kitchen, PASTA_STOCK);
    await callWrite(client, 'start_cooking', { recipe_name: 'creamy spinach pasta' });
    const tiny = await callWrite(client, 'propose_consumption', { overrides: [{ item: 'milk', quantity: 0.0004 }] });
    expect(parseErrorResult(tiny)).toMatchObject({ code: 'invalid_quantity', item: 'milk' });
  });

  it('is stale when a pinned batch changed, even if another batch could cover it (R20, FR-17)', async () => {
    const p = await propose(); // 250 ml milk, pinned to batch A
    // A is thrown out; B still has 1000 ml.
    expect((await adjustStock(servers, client, { batch_id: milkA, delta: -1000, reason: 'discard' })).status).toBe(200);
    const res = await confirm(p, 1);
    expect(res).toMatchObject({ status: 409, body: { code: 'stale_state', reason: 'batch_changed' } });
    expect(await consumeEvents()).toEqual([]);
    expect(await quantity(milkB)).toBe(1000);
    const confirmation = await withAdmin(async (admin) =>
      (await admin.query(`SELECT outcome FROM pantry.confirmations WHERE proposal_id = $1`, [p.proposal_id])).rows,
    );
    expect(confirmation).toEqual([{ outcome: 'stale' }]);

    // A new card plans from current stock: the milk now comes from B.
    const fresh = await propose();
    expect(fresh.proposal_id).not.toBe(p.proposal_id);
    expect((await confirm(fresh, 1)).status).toBe(200);
    expect(await quantity(milkB)).toBe(750);
    expect(await ledgerMismatches(kitchen.householdId)).toEqual([]);
  });

  it('is stale when the session changed under the card', async () => {
    const p = await propose();
    await withAdmin((admin) =>
      admin.query(`UPDATE pantry.cooking_sessions SET state_version = state_version + 1 WHERE id = $1`, [sessionId]),
    );
    expect(await confirm(p, 1)).toMatchObject({ status: 409, body: { code: 'stale_state', reason: 'session_changed' } });
  });

  it('serializes a confirm behind an adjustment confirm holding the pinned batch: no deadlock, no double use (R8a)', async () => {
    const p = await propose(); // 250 ml milk from A
    const adjust = (await callWrite(client, 'propose_adjustment', { batch_id: milkA, delta: -100, reason: 'discard' }))
      .structuredContent as { proposal_id: string };
    const other = new pg.Client({ connectionString: TEST_ADMIN_URL });
    await other.connect();
    try {
      // Hold batch A's row lock so the adjustment confirm queues on it first, then the consume confirm.
      await other.query('BEGIN');
      await other.query(`SELECT 1 FROM pantry.batches WHERE id = $1 FOR UPDATE`, [milkA]);
      const adjusting = confirm(adjust, 1);
      await waitForLockWaiters(1);
      const consuming = confirm(p, 1);
      await waitForLockWaiters(2);
      await other.query('COMMIT');
      expect((await adjusting).status).toBe(200);
      expect(await consuming).toMatchObject({ status: 409, body: { code: 'stale_state', reason: 'batch_changed' } });
    } finally {
      await other.end();
    }
    expect(await quantity(milkA)).toBe(900);
    expect(await consumeEvents()).toEqual([]);
    expect(await ledgerMismatches(kitchen.householdId)).toEqual([]);
  });

  // Lock order (§4.3): with the session held, queue a re-propose, then a confirm, behind it. If confirm
  // took the card before the session it would hold what the re-propose needs next: a deadlock.
  it('takes the session before the card, so a confirm racing a re-propose cannot deadlock', async () => {
    const p = await propose();
    const other = new pg.Client({ connectionString: TEST_ADMIN_URL });
    await other.connect();
    try {
      await other.query('BEGIN');
      await other.query(`SELECT 1 FROM pantry.cooking_sessions WHERE id = $1 FOR UPDATE`, [sessionId]);
      const reproposing = callWrite(client, 'propose_consumption', { overrides: [{ item: 'milk', quantity: 300 }] });
      await waitForLockWaiters(1);
      const confirming = confirm(p, 1);
      await waitForLockWaiters(2);
      await other.query('COMMIT');

      const reproposed = await reproposing;
      expect(parseErrorResult(reproposed)).toBeNull();
      expect(reproposed.structuredContent).toMatchObject({ proposal_id: p.proposal_id, version: 2 });
      expect(await confirming).toMatchObject({ status: 409, body: { code: 'stale_proposal', current_version: 2 } });
    } finally {
      await other.end();
    }
    expect(await consumeEvents()).toEqual([]);
  });

  it('records a spoken confirmation, then lets the next recipe start', async () => {
    const p = await propose();
    const res = await confirm(p, 1, { channel: 'voice_rule', utterance: 'confirm' });
    expect(res.status).toBe(200);
    expect(parseErrorResult(await callWrite(client, 'next_step', { expected_step: 1 }))?.code).toBe('no_active_session');
    await stockKitchen(kitchen, { egg: 6, tomato: 4, 'olive oil': 100, scallion: 2 });
    expect(parseErrorResult(await callWrite(client, 'start_cooking', { recipe_name: 'tomato egg stir-fry' }))).toBeNull();
  });
});
