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
      body: { kind: 'adjust', summary: { item: 'egg', unit: 'count', reason: 'discard', delta: -6, set_quantity: null, new_batch: false } },
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
    const res = await confirmCard(servers, p, 1);
    // The summary carries the count as well as the change, so "you have 10 now" can be said.
    expect(res).toMatchObject({ status: 200, body: { summary: { item: 'egg', unit: 'count', delta: -2, set_quantity: 10 } } });
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

  it('counts stock for batch "new" into a new batch, leaving the existing ones alone', async () => {
    const p = await ok({ item: 'egg', batch_id: 'new', set_quantity: 2 });
    expect(p.card.lines).toEqual(['+2 eggs · new batch, bought today, no package date']);
    expect((await confirmCard(servers, p, 1)).status).toBe(200);
    expect(await batch(eggOld)).toMatchObject({ quantity: 4, version: 1 });
    expect(await batch(eggNew)).toMatchObject({ quantity: 12, version: 1 });
    expect(await events('adjust')).toEqual([{ batch_id: expect.not.stringMatching(new RegExp(`${eggOld}|${eggNew}`)), delta: 2 }]);
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
    expect(p.card.warnings).toEqual(['The meal being cooked would be 1 scallion short.']);
    // The read-back says it, exactly, before the question (eval P10: the model's account was wrong).
    expect(p.card.readback_text).toBe(
      "I'll record that 3 scallions were thrown out. That leaves the meal 1 scallion short: you can carry on with less, " +
        'use a substitute, add scallion to the shopping list, or cook it another time. Say confirm, or tell me what to change.',
    );
    // Enough left: nothing about the meal.
    const some = await ok({ item: 'scallion', delta: -1, reason: 'discard' });
    expect(some.impact_on_active_session).toEqual([{ item: 'scallion', planned: 2, available_after: 3, short: 0 }]);
    expect(some.card.readback_text).toBe("I'll record that 1 scallion was thrown out. Say confirm, or tell me what to change.");
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

  it('works out a share of the stock and says how, so the user can correct it', async () => {
    const p = await ok({ item: 'egg', share: { fraction: 0.5, of: 'stock' }, reason: 'discard' });
    expect(p.card.readback_text).toBe("I'll record that 8 eggs were thrown out: half of the 16 eggs you had. Say confirm, or tell me what to change.");
    // Counted items go whole: a third of 16 is 5.
    const third = await ok({ batch_id: eggNew, share: { fraction: 1 / 3, of: 'stock' }, reason: 'discard' });
    expect(third.card.readback_text).toMatch(/^I'll record that 4 eggs were thrown out: a third of the 12 eggs you had\./);
    const quarter = await ok({ batch_id: eggOld, share: { fraction: 0.25, of: 'stock' }, reason: 'discard' });
    expect(quarter.card.readback_text).toMatch(/^I'll record that 1 egg was thrown out: a quarter of the 4 eggs you had\./);
    expect((await stored(p.proposal_id)).input).toMatchObject({ share: { fraction: 0.5, of: 'stock' } });
  });

  it('re-proposes a corrected share as a new version of the same card, and commits the one confirmed', async () => {
    await startPasta(kitchen, client); // milk: 1000 ml in stock, 250 ml in the recipe
    const milk = kitchen.items.milk!;
    const half = await ok({ item: 'milk', share: { fraction: 0.5, of: 'stock' }, reason: 'discard' });
    expect(half.card.readback_text).toMatch(/^I'll record that 500 milliliters of milk were thrown out: half of the 1000 milliliters of milk you had\./);
    // "No, half of what the recipe uses."
    const corrected = await ok({ item: 'milk', share: { fraction: 0.5, of: 'recipe' }, reason: 'discard' });
    expect(corrected).toMatchObject({ proposal_id: half.proposal_id, version: 2 });
    expect(corrected.card.readback_text).toMatch(/^I'll record that 125 milliliters of milk were thrown out: half of the 250 milliliters of milk the recipe uses\./);
    expect((await confirmCard(servers, corrected, 2)).status).toBe(200);
    const left = await withAdmin(async (admin) =>
      Number((await admin.query(`SELECT sum(quantity) AS n FROM pantry.batches WHERE item_id = $1`, [milk])).rows[0].n),
    );
    expect(left).toBe(875);
  });

  it('refuses a share it cannot work out', async () => {
    const codes = async (args: Record<string, unknown>) => parseErrorResult(await propose(args))?.code;
    const half = { fraction: 0.5, of: 'stock' };
    expect(await codes({ item: 'egg', share: half, delta: -1 })).toBe('invalid_quantity');
    expect(await codes({ item: 'egg', share: half, reason: 'found_more' })).toBe('invalid_quantity');
    expect(await codes({ item: 'egg', share: { fraction: 0.5, of: 'recipe' } })).toBe('needs_clarification'); // nothing cooking
    expect(await codes({ item: 'yogurt', share: half })).toBe('no_change');
    await stockKitchen(kitchen, { tomato: 1 });
    expect(await codes({ item: 'tomato', share: { fraction: 0.25, of: 'stock' } })).toBe('invalid_quantity'); // less than one tomato
    // "200 ml" of a litre is an amount, not a share someone names (eval P4).
    expect(await codes({ item: 'egg', share: { fraction: 0.2, of: 'stock' } })).toBe('invalid_quantity');
  });

  it('edits a share card as the change it worked out to; an edit onto other batches replaces the card', async () => {
    // Half of 16 eggs spans both batches; 2 eggs come from the oldest alone, another subject (§4.1).
    const p = await ok({ item: 'egg', share: { fraction: 0.5, of: 'stock' }, reason: 'discard' });
    const view = await internalCall(servers, `/internal/proposals/${p.proposal_id}`, undefined, 'GET');
    expect(view.body.editable).toEqual({ type: 'amount', field: 'delta', item: 'egg', value: -8, unit: 'count' });
    const edited = await internalCall(
      servers,
      `/internal/proposals/${p.proposal_id}`,
      { base_version: 1, changes: { delta: -2 }, request_id: randomUUID() },
      'PATCH',
    );
    expect(edited).toMatchObject({ status: 200, body: { version: 1, kind: 'adjust', superseded: p.proposal_id } });
    const replacement = edited.body.proposal_id as string;
    expect(replacement).not.toBe(p.proposal_id);
    expect(await stored(p.proposal_id)).toMatchObject({ status: 'superseded' });
    expect(await stored(replacement)).toMatchObject({ status: 'pending', input: { item: 'egg', delta: -2, reason: 'discard' } });
    expect((await confirmCard(servers, p, 1)).status).toBe(409);
    expect((await confirmCard(servers, { proposal_id: replacement }, 1)).status).toBe(200);
    expect(await batch(eggOld)).toMatchObject({ quantity: 2 });
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
