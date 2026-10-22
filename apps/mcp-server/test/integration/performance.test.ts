// §9.9 Performance: with 50 items, 200 batches and 500 inventory events, every tool answers within
// 200 ms at p95, measured by the client over loopback HTTP (so an upper bound on the server's time).
import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningServers, startServers } from '../../src/app.ts';
import {
  callWrite,
  connectMcpClient,
  createDemoKitchen,
  type DemoKitchen,
  eatMeal,
  ledgerMismatches,
  mcpTestConfig,
  withAdmin,
} from '../../../../test/fixtures.ts';

const ITEMS = 50;
const BATCHES_PER_ITEM = 4;
const CONSUME_OPS = 100;
const EVENTS_PER_CONSUME = 3;
const ROUNDS = 20;
const P95_MS = 200;

/**
 * Stocks the kitchen to the §9.9 size in one transaction: the demo catalog topped up to 50 items,
 * 4 batches of each, each bought by its own intake (200 purchase events), and 100 meals of 3 lines
 * (300 consume events). Each batch holds what its events add up to (invariant I1).
 */
async function seedLoad(kitchen: DemoKitchen): Promise<void> {
  await withAdmin(async (admin) => {
    const hh = kitchen.householdId;
    await admin.query('BEGIN');
    const extra = Array.from({ length: ITEMS - Object.keys(kitchen.items).length }, (_, i) => ({ id: randomUUID(), name: `perf item ${i + 1}` }));
    await admin.query(
      `INSERT INTO pantry.items (id, household_id, name, aliases, base_unit, category)
       SELECT id, $1, name, '{}', 'count', 'other' FROM unnest($2::uuid[], $3::text[]) AS t(id, name)`,
      [hh, extra.map((e) => e.id), extra.map((e) => e.name)],
    );
    const itemIds = [...Object.values(kitchen.items), ...extra.map((e) => e.id)];
    expect(itemIds).toHaveLength(ITEMS);

    const ops: Array<{ id: string; proposal: string; confirmation: string; kind: 'intake' | 'consume'; minutesAgo: number }> = [];
    const op = (kind: 'intake' | 'consume', minutesAgo: number) => {
      const o = { id: randomUUID(), proposal: randomUUID(), confirmation: randomUUID(), kind, minutesAgo };
      ops.push(o);
      return o.id;
    };
    const batches = itemIds.flatMap((item, i) =>
      Array.from({ length: BATCHES_PER_ITEM }, (_, j) => ({ id: randomUUID(), item, quantity: 1000, daysAgo: (i + j) % 10, op: op('intake', 1000 + i * 4 + j) })),
    );
    const events = batches.map((b) => ({ id: randomUUID(), op: b.op, batch: b.id, item: b.item, delta: b.quantity, reason: 'purchase' }));
    for (let m = 0; m < CONSUME_OPS; m++) {
      const id = op('consume', CONSUME_OPS - m);
      for (let k = 0; k < EVENTS_PER_CONSUME; k++) {
        const b = batches[(m * EVENTS_PER_CONSUME + k) % batches.length]!;
        b.quantity -= 1;
        events.push({ id: randomUUID(), op: id, batch: b.id, item: b.item, delta: -1, reason: 'consume' });
      }
    }

    await admin.query(
      `INSERT INTO pantry.proposals (id, household_id, conversation_id, kind, subject_key, input, payload, preconditions, status, expires_at)
       SELECT p, $1, gen_random_uuid(), k, 'perf:' || p, '{}', '{}', '{}', 'committed', now() FROM unnest($2::uuid[], $3::text[]) AS t(p, k)`,
      [hh, ops.map((o) => o.proposal), ops.map((o) => o.kind)],
    );
    await admin.query(
      `INSERT INTO pantry.confirmations (id, household_id, proposal_id, version, user_id, channel, request_id, outcome)
       SELECT c, $1, p, 1, 'perf', 'ui_click', gen_random_uuid(), 'committed' FROM unnest($2::uuid[], $3::uuid[]) AS t(c, p)`,
      [hh, ops.map((o) => o.confirmation), ops.map((o) => o.proposal)],
    );
    await admin.query(
      `INSERT INTO pantry.operations (id, household_id, kind, proposal_id, proposal_version, confirmation_id, summary, created_at)
       SELECT id, $1, k, p, 1, c, '{}', now() - make_interval(mins => m)
         FROM unnest($2::uuid[], $3::text[], $4::uuid[], $5::uuid[], $6::int[]) AS t(id, k, p, c, m)`,
      [hh, ops.map((o) => o.id), ops.map((o) => o.kind), ops.map((o) => o.proposal), ops.map((o) => o.confirmation), ops.map((o) => o.minutesAgo)],
    );
    await admin.query(
      `INSERT INTO pantry.batches (id, household_id, item_id, quantity, purchased_at, priority_date, priority_source, status, created_by_op)
       SELECT id, $1, item, q, CURRENT_DATE - d, CURRENT_DATE - d + 7, 'estimate', 'active', op
         FROM unnest($2::uuid[], $3::uuid[], $4::numeric[], $5::int[], $6::uuid[]) AS t(id, item, q, d, op)`,
      [hh, batches.map((b) => b.id), batches.map((b) => b.item), batches.map((b) => b.quantity), batches.map((b) => b.daysAgo), batches.map((b) => b.op)],
    );
    await admin.query(
      `INSERT INTO pantry.inventory_events (id, household_id, operation_id, batch_id, item_id, delta, reason)
       SELECT id, $1, op, b, item, delta, reason FROM unnest($2::uuid[], $3::uuid[], $4::uuid[], $5::uuid[], $6::numeric[], $7::text[]) AS t(id, op, b, item, delta, reason)`,
      [hh, events.map((e) => e.id), events.map((e) => e.op), events.map((e) => e.batch), events.map((e) => e.item), events.map((e) => e.delta), events.map((e) => e.reason)],
    );
    await admin.query('COMMIT');
  });
}

/** One round: every tool once, in an order each call's preconditions hold (a fresh session each round). */
const ROUND: Array<[string, Record<string, unknown>]> = [
  ['list_inventory', {}],
  ['list_inventory', { item: 'egg' }],
  ['expiring_soon', { within_days: 3 }],
  ['suggest_recipes', {}],
  ['list_recent_operations', {}],
  ['propose_intake', { items: [{ name: 'egg', quantity: 6 }] }],
  ['propose_adjustment', { item: 'egg', delta: -1, reason: 'discard' }],
  ['propose_undo', { target: 'last' }],
  ['propose_consumption_revision', { usage: [{ item: 'egg', quantity: 4 }] }],
  ['add_to_shopping_list', { items: [{ name: 'dish soap' }] }],
  ['start_cooking', { recipe_name: 'creamy spinach pasta' }],
  ['get_session', {}],
  ['next_step', { expected_step: 1 }],
  ['substitute', { from_item: 'scallion', to_item: 'onion' }],
  ['skip_ingredient', { item: 'parmesan' }],
  ['propose_consumption', {}],
  ['cancel_cooking', {}],
];

const p95 = (ms: number[]) => [...ms].sort((a, b) => a - b)[Math.ceil(ms.length * 0.95) - 1]!;

describe('§9.9 performance', () => {
  let servers: RunningServers;
  let client: Client;
  beforeAll(async () => {
    servers = await startServers(mcpTestConfig(), { log: false });
    const kitchen = await createDemoKitchen();
    await seedLoad(kitchen);
    expect(await ledgerMismatches(kitchen.householdId)).toEqual([]);
    client = await connectMcpClient(servers, kitchen.token);
    // A meal of the tools' own, for the revision and undo cards.
    await eatMeal(servers, client, 'tomato egg stir-fry');
  }, 60_000);
  afterAll(async () => {
    await client?.close();
    await servers?.close();
  });

  it(`answers every tool within ${P95_MS} ms at p95`, async () => {
    const times = new Map<string, number[]>();
    for (let round = -1; round < ROUNDS; round++) {
      for (const [name, args] of ROUND) {
        const started = performance.now();
        const res = await callWrite(client, name, args);
        const ms = performance.now() - started;
        expect(res.isError, `${name}: ${JSON.stringify(res.content)}`).toBeFalsy();
        // Round -1 warms the pools and the JIT.
        if (round >= 0) times.set(name, [...(times.get(name) ?? []), ms]);
      }
    }
    const report = [...times].map(([name, ms]) => ({ name, p95: Math.round(p95(ms)) }));
    console.log(report.map((r) => `${r.name.padEnd(30)} p95 ${r.p95} ms`).join('\n'));
    expect(report.filter((r) => r.p95 >= P95_MS)).toEqual([]);
  }, 120_000);
});
