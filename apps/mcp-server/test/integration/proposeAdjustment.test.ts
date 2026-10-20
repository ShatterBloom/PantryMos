// propose_adjustment and its confirm (§6.2, §4.2): R8a, R23 (two adjustments), R26.
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
  internalCall,
  ledgerMismatches,
  mcpTestConfig,
  PASTA_STOCK,
  startPasta,
  stockKitchen,
  todayIn,
  withAdmin,
} from '../../../../test/fixtures.ts';

interface Proposed {
  proposal_id: string;
  version: number;
  card: { title: string; lines: string[]; warnings: string[]; readback_text: string };
  impact_on_active_session: Array<{ item: string; planned: number; available_after: number; short: number }>;
}

describe('propose_adjustment', () => {
  let servers: RunningServers;
  beforeAll(async () => {
    servers = await startServers(mcpTestConfig(), { log: false });
  });
  afterAll(async () => servers.close());

  let kitchen: DemoKitchen;
  let client: Client;
  let eggOld: string; // 4 eggs, used first
  let eggNew: string; // 12 eggs
  beforeEach(async () => {
    kitchen = await createDemoKitchen();
    client = await connectMcpClient(servers, kitchen.token);
    eggOld = (await stockKitchen(kitchen, { egg: 4 }, 10)).egg!;
    eggNew = (await stockKitchen(kitchen, { egg: 12 }, 1)).egg!;
    return () => client.close();
  });

  const propose = (args: Record<string, unknown>) => callWrite(client, 'propose_adjustment', { reason: 'stock_check', ...args });
  const ok = async (args: Record<string, unknown>) => {
    const res = await propose(args);
    expect(parseErrorResult(res)).toBeNull();
    return res.structuredContent as unknown as Proposed;
  };
  const batch = async (id: string) =>
    withAdmin(async (admin) =>
      (await admin.query(`SELECT quantity::float AS quantity, status, version FROM pantry.batches WHERE id = $1`, [id])).rows[0],
    );
  const stored = async (proposalId: string) =>
    withAdmin(async (admin) => (await admin.query(`SELECT * FROM pantry.proposals WHERE id = $1`, [proposalId])).rows[0]);
  const events = async (reason: string) =>
    withAdmin(async (admin) =>
      (
        await admin.query(`SELECT batch_id, delta::float AS delta FROM pantry.inventory_events WHERE household_id = $1 AND reason = $2`, [
          kitchen.householdId,
          reason,
        ])
      ).rows,
    );

  it('throws out stock oldest first and marks an emptied batch discarded', async () => {
    const p = await ok({ item: 'eggs', delta: -6, reason: 'discard' });
    expect(p.card).toMatchObject({
      title: 'Throw out egg',
      lines: [expect.stringMatching(/^−4 eggs · stored for 10 days/), expect.stringMatching(/^−2 eggs · stored for 1 day/)],
      readback_text: "I'll record that 6 eggs were thrown out. Say confirm, or tell me what to change.",
    });
    expect(await stored(p.proposal_id)).toMatchObject({ subject_key: `adjust:item:${kitchen.items.egg}`, status: 'pending' });
    expect(await batch(eggOld)).toMatchObject({ quantity: 4 }); // unchanged until confirmed

    const res = await confirmCard(servers, p, 1);
    expect(res).toMatchObject({
      status: 200,
      body: { kind: 'adjust', summary: { item: 'egg', unit: 'count', reason: 'discard', delta: -6, new_batch: false } },
    });
    expect(await batch(eggOld)).toMatchObject({ quantity: 0, status: 'discarded' });
    expect(await batch(eggNew)).toMatchObject({ quantity: 10, status: 'active' });
    expect(await events('discard')).toHaveLength(2);
    expect(await ledgerMismatches(kitchen.householdId)).toEqual([]);
  });

  it('sets a counted quantity on one batch, pinning its version', async () => {
    const p = await ok({ batch_id: eggNew, set_quantity: 10 }); // item comes from the batch
    expect(p.card.lines).toEqual([expect.stringMatching(/^−2 eggs · stored for 1 day/)]);
    expect((await stored(p.proposal_id)).preconditions).toEqual({ batches: [{ id: eggNew, version: 1 }] });
    expect((await confirmCard(servers, p, 1)).status).toBe(200);
    expect(await batch(eggNew)).toMatchObject({ quantity: 10, version: 2 });
    expect(await events('adjust')).toEqual([{ batch_id: eggNew, delta: -2 }]);
  });

  it('asks which batch found stock belongs to, then adds it to the chosen one or a new batch (R26)', async () => {
    const ambiguous = parseErrorResult(await propose({ item: 'egg', delta: 3, reason: 'found_more' }));
    expect(ambiguous).toMatchObject({ code: 'ambiguous_batch' });
    expect((ambiguous!.options as Array<{ batch_id: string }>).map((o) => o.batch_id)).toEqual([eggOld, eggNew, 'new']);

    expect((await adjustStock(servers, client, { item: 'egg', batch_id: eggOld, delta: 3, reason: 'found_more' })).status).toBe(200);
    expect(await batch(eggOld)).toMatchObject({ quantity: 7 });

    const fresh = await ok({ item: 'egg', batch_id: 'new', delta: 6, reason: 'found_more' });
    expect(fresh.card.lines).toEqual(['+6 eggs · new batch, bought today, no package date']);
    expect(fresh.card.readback_text).toBe("I'll add 6 eggs to the stock as a new batch. Say confirm, or tell me what to change.");
    expect((await stored(fresh.proposal_id)).subject_key).toBe(`adjust:newbatch:${kitchen.items.egg}`);
    expect((await confirmCard(servers, fresh, 1)).status).toBe(200);

    const today = await todayIn('America/Los_Angeles');
    const created = await withAdmin(async (admin) =>
      (
        await admin.query(
          `SELECT quantity::float AS quantity, purchased_at::text, priority_source, status, version FROM pantry.batches
            WHERE household_id = $1 AND item_id = $2 AND id <> ALL ($3::uuid[])`,
          [kitchen.householdId, kitchen.items.egg, [eggOld, eggNew]],
        )
      ).rows,
    );
    expect(created).toEqual([{ quantity: 6, purchased_at: today, priority_source: 'estimate', status: 'active', version: 1 }]);
    expect(await ledgerMismatches(kitchen.householdId)).toEqual([]);
  });

  it('keeps adjustments on different batches pending side by side (R23)', async () => {
    const a = await ok({ batch_id: eggOld, delta: -1 });
    const b = await ok({ batch_id: eggNew, delta: -1 });
    expect(a.proposal_id).not.toBe(b.proposal_id);
    const statuses = await withAdmin(async (admin) =>
      (await admin.query(`SELECT status FROM pantry.proposals WHERE id = ANY ($1::uuid[])`, [[a.proposal_id, b.proposal_id]])).rows,
    );
    expect(statuses).toEqual([{ status: 'pending' }, { status: 'pending' }]);
    // The same batch again: a new version of the same card.
    expect(await ok({ batch_id: eggOld, delta: -2 })).toMatchObject({ proposal_id: a.proposal_id, version: 2 });
  });

  it('reports the effect on the meal being cooked', async () => {
    await startPasta(kitchen, client); // the pasta plans 2 scallions; 4 are in stock
    const p = await ok({ item: 'scallion', delta: -3, reason: 'discard' });
    expect(p.impact_on_active_session).toEqual([{ item: 'scallion', planned: 2, available_after: 1, short: 1 }]);
    expect(p.card.warnings).toEqual(['The meal being cooked would be short of scallion.']);
    expect((await ok({ item: 'egg', delta: -1 })).impact_on_active_session).toEqual([]);
  });

  it('refuses what it cannot do', async () => {
    const other = await createDemoKitchen();
    const foreign = (await stockKitchen(other, { egg: 6 })).egg!;
    const codes = async (args: Record<string, unknown>) => parseErrorResult(await propose(args))?.code;

    expect(await codes({ item: 'egg', delta: -17 })).toBe('would_go_negative');
    expect(await codes({ batch_id: foreign, delta: -1 })).toBe('not_found');
    expect(await codes({ item: 'milk', batch_id: eggOld, delta: -1 })).toBe('not_found');
    expect(await codes({ item: 'unobtainium', delta: 1 })).toBe('unknown_item');
    expect(await codes({ delta: 1 })).toBe('needs_clarification');
    expect(await codes({ item: 'egg', delta: -1, set_quantity: 2 })).toBe('invalid_quantity');
    expect(await codes({ item: 'egg', set_quantity: 3 })).toBe('ambiguous_batch');
  });

  it('applies a card edit as the new amount', async () => {
    const p = await ok({ batch_id: eggOld, delta: -1 });
    const edited = await internalCall(
      servers,
      `/internal/proposals/${p.proposal_id}`,
      { base_version: 1, changes: { delta: -3 }, request_id: randomUUID() },
      'PATCH',
    );
    expect(edited).toMatchObject({ status: 200, body: { version: 2, outcome: 'new_version' } });
    expect((await stored(p.proposal_id)).input).toMatchObject({ batch_id: eggOld, delta: -3, reason: 'stock_check' });
    expect((await confirmCard(servers, p, 2)).status).toBe(200);
    expect(await batch(eggOld)).toMatchObject({ quantity: 1 });
  });

  it('commits exactly one of a consume card and an adjustment pinning the same batch, confirmed concurrently (R8a)', async () => {
    await stockKitchen(kitchen, PASTA_STOCK);
    const scallions = await withAdmin(async (admin) =>
      (await admin.query(`SELECT id FROM pantry.batches WHERE household_id = $1 AND item_id = $2`, [kitchen.householdId, kitchen.items.scallion]))
        .rows[0].id as string,
    );
    await callWrite(client, 'start_cooking', { recipe_name: 'creamy spinach pasta' });
    const consume = (await callWrite(client, 'propose_consumption', {})).structuredContent as { proposal_id: string };
    const adjust = await ok({ batch_id: scallions, delta: -1, reason: 'discard' });

    const results = await Promise.all([confirmCard(servers, consume, 1), confirmCard(servers, adjust, 1)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body).toMatchObject({ code: 'stale_state', reason: 'batch_changed' });
    const left = (await batch(scallions)).quantity;
    expect([2, 3]).toContain(left); // 4 − 2 (pasta) or 4 − 1 (discard), never both
    expect(await ledgerMismatches(kitchen.householdId)).toEqual([]);
  });
});
