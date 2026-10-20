// Internal confirm for intake (§4.3): R2–R4, R18, R19, R21, R22, R27, expiry, validation, rate limit.
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { META_CONVERSATION_ID, META_REQUEST_ID } from '@pantrymos/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningServers, startServers } from '../../src/app.ts';
import { addDays } from '../../src/domain/dates.ts';
import { parseErrorResult } from '../../src/mcp/toolkit.ts';
import {
  connectMcpClient,
  createHousehold,
  createItem,
  type HouseholdFixture,
  mcpTestConfig,
  TEST_SERVICE_TOKEN,
  todayIn,
  withAdmin,
} from '../../../../test/fixtures.ts';

interface Proposed {
  proposal_id: string;
  version: number;
}

describe('confirm intake', () => {
  let servers: RunningServers;
  let hh: HouseholdFixture;
  let client: Client;
  let internalUrl: string;
  let eggId: string;

  beforeAll(async () => {
    hh = await createHousehold();
    eggId = await createItem(hh.householdId, { name: 'egg', default_shelf_days: 21 });
    await createItem(hh.householdId, { name: 'milk', base_unit: 'ml', default_shelf_days: 7 });
    servers = await startServers(mcpTestConfig(), { log: false });
    client = await connectMcpClient(servers, hh.token);
    const { port } = servers.internal.server.address() as AddressInfo;
    internalUrl = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => {
    await client.close();
    await servers.close();
  });

  const propose = async (items: unknown[], conversationId: string = randomUUID()) => {
    const res = await client.callTool({
      name: 'propose_intake',
      arguments: { items },
      _meta: { [META_REQUEST_ID]: randomUUID(), [META_CONVERSATION_ID]: conversationId },
    });
    return res;
  };
  const proposeOk = async (items: unknown[], conversationId?: string) => {
    const res = await propose(items, conversationId);
    expect(parseErrorResult(res)).toBeNull();
    return res.structuredContent as unknown as Proposed;
  };

  const confirm = async (proposalId: string, body: Record<string, unknown>) => {
    const res = await fetch(`${internalUrl}/internal/proposals/${proposalId}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-token': TEST_SERVICE_TOKEN },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const confirmBody = (version: number, overrides: Record<string, unknown> = {}) => ({
    version,
    user_id: 'demo',
    channel: 'ui_click',
    request_id: randomUUID(),
    ...overrides,
  });

  const db = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    withAdmin(async (admin) => (await admin.query(sql, params)).rows as T[]);
  const counts = async (proposalId: string) =>
    (
      await db<{ confirmations: number; operations: number }>(
        `SELECT (SELECT count(*) FROM pantry.confirmations WHERE proposal_id = $1)::int AS confirmations,
                (SELECT count(*) FROM pantry.operations WHERE proposal_id = $1)::int AS operations`,
        [proposalId],
      )
    )[0]!;
  const proposalStatus = async (id: string) =>
    (await db<{ status: string; stale_reason: string | null }>(`SELECT status, stale_reason FROM pantry.proposals WHERE id = $1`, [id]))[0];

  /** I1: every batch quantity equals the sum of its events. */
  const assertLedgerConsistent = async () => {
    const broken = await db(
      `SELECT b.id FROM pantry.batches b
         LEFT JOIN pantry.inventory_events e ON e.batch_id = b.id
        WHERE b.household_id = $1
        GROUP BY b.id, b.quantity
       HAVING b.quantity <> COALESCE(sum(e.delta), 0)`,
      [hh.householdId],
    );
    expect(broken).toEqual([]);
  };

  it('commits an intake: batches with +Q purchase events, one operation, one confirmation (R18, B1)', async () => {
    const today = await todayIn('America/Los_Angeles');
    const bestBy = addDays(today, 30); // relative, so the test never drifts out of the ±730-day window
    const p = await proposeOk([
      { name: 'eggs', quantity: 12 },
      { name: 'milk', quantity: 1, unit: 'l', package_date: bestBy, package_date_type: 'best_by' },
    ]);
    const res = await confirm(p.proposal_id, confirmBody(1));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'committed',
      proposal_id: p.proposal_id,
      version: 1,
      kind: 'intake',
      operation_id: expect.any(String),
      summary: {
        lines: [
          { item: 'egg', quantity: 12, unit: 'count' },
          { item: 'milk', quantity: 1000, unit: 'ml' },
        ],
        new_items: [],
        new_conversions: [],
      },
    });

    const batches = await db(
      `SELECT b.item_id, b.quantity::int, b.purchased_at::text, b.package_date::text, b.package_date_type, b.priority_source,
              b.status, b.version, b.created_by_op,
              (SELECT json_agg(json_build_object('delta', e.delta::int, 'reason', e.reason, 'op', e.operation_id))
                 FROM pantry.inventory_events e WHERE e.batch_id = b.id) AS events
         FROM pantry.batches b WHERE b.created_by_op = $1 ORDER BY b.quantity`,
      [res.body.operation_id],
    );
    const op = res.body.operation_id;
    expect(batches).toEqual([
      {
        item_id: eggId, quantity: 12, purchased_at: today, package_date: null, package_date_type: null,
        priority_source: 'estimate', status: 'active', version: 1, created_by_op: op,
        events: [{ delta: 12, reason: 'purchase', op }],
      },
      expect.objectContaining({
        quantity: 1000, package_date: bestBy, package_date_type: 'best_by', priority_source: 'package',
        status: 'active', version: 1, events: [{ delta: 1000, reason: 'purchase', op }],
      }),
    ]);
    expect(await counts(p.proposal_id)).toEqual({ confirmations: 1, operations: 1 });
    expect(await proposalStatus(p.proposal_id)).toEqual({ status: 'committed', stale_reason: null });
    const [confirmation] = await db(
      `SELECT version, user_id, channel, outcome, utterance FROM pantry.confirmations WHERE proposal_id = $1`,
      [p.proposal_id],
    );
    expect(confirmation).toEqual({ version: 1, user_id: 'demo', channel: 'ui_click', outcome: 'committed', utterance: null });

    // The new stock is visible to read tools.
    const inv = await client.callTool({ name: 'list_inventory', arguments: { item: 'milk' } });
    expect((inv.structuredContent as { items: Array<{ total: number }> }).items[0]?.total).toBe(1000);
    await assertLedgerConsistent();
  });

  it('records a voice confirmation with its utterance', async () => {
    const p = await proposeOk([{ name: 'egg', quantity: 2 }]);
    const res = await confirm(p.proposal_id, confirmBody(1, { channel: 'voice_rule', utterance: "that's right" }));
    expect(res.status).toBe(200);
    expect(await db(`SELECT channel, utterance FROM pantry.confirmations WHERE proposal_id = $1`, [p.proposal_id])).toEqual([
      { channel: 'voice_rule', utterance: "that's right" },
    ]);
  });

  it('replays the stored outcome for a retried request_id (R2, R19)', async () => {
    const p = await proposeOk([{ name: 'egg', quantity: 6 }]);
    const body = confirmBody(1);
    const first = await confirm(p.proposal_id, body);
    const retry = await confirm(p.proposal_id, body); // e.g. the first response was lost
    expect(retry).toEqual(first);
    expect(await counts(p.proposal_id)).toEqual({ confirmations: 1, operations: 1 });
  });

  it('commits once when the same request races itself (R19, double tap)', async () => {
    const p = await proposeOk([{ name: 'egg', quantity: 3 }]);
    const body = confirmBody(1);
    const results = await Promise.all([confirm(p.proposal_id, body), confirm(p.proposal_id, body), confirm(p.proposal_id, body)]);
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(results[0]?.status).toBe(200);
    expect(await counts(p.proposal_id)).toEqual({ confirmations: 1, operations: 1 });
    await assertLedgerConsistent();
  });

  it('answers a second confirm with a new request_id with already_committed and the original summary (R3)', async () => {
    const p = await proposeOk([{ name: 'egg', quantity: 4 }]);
    const first = await confirm(p.proposal_id, confirmBody(1));
    const again = await confirm(p.proposal_id, confirmBody(1));
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({
      code: 'already_committed',
      operation_id: first.body.operation_id,
      version: 1,
      summary: first.body.summary,
    });
    expect(await counts(p.proposal_id)).toEqual({ confirmations: 1, operations: 1 });
  });

  it('rejects confirming an older version and writes nothing (R4, E2)', async () => {
    const conversationId = randomUUID();
    const v1 = await proposeOk([{ name: 'egg', quantity: 6 }], conversationId);
    const v2 = await proposeOk([{ name: 'egg', quantity: 5 }], conversationId);
    expect(v2).toMatchObject({ proposal_id: v1.proposal_id, version: 2 });

    const stale = await confirm(v1.proposal_id, confirmBody(1));
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'stale_proposal', current_version: 2 });
    expect(await counts(v1.proposal_id)).toEqual({ confirmations: 0, operations: 0 });
    expect((await proposalStatus(v1.proposal_id))?.status).toBe('pending');

    const ok = await confirm(v1.proposal_id, confirmBody(2));
    expect(ok.body).toMatchObject({ status: 'committed', version: 2, summary: { lines: [{ item: 'egg', quantity: 5 }] } });
  });

  it('expires a card past its deadline, durably (§3.2)', async () => {
    const p = await proposeOk([{ name: 'egg', quantity: 1 }]);
    await db(`UPDATE pantry.proposals SET expires_at = now() - interval '1 second' WHERE id = $1`, [p.proposal_id]);
    const body = confirmBody(1);
    const res = await confirm(p.proposal_id, body);
    expect(res).toMatchObject({ status: 409, body: { code: 'expired' } });
    expect((await proposalStatus(p.proposal_id))?.status).toBe('expired');
    expect(await db(`SELECT outcome FROM pantry.confirmations WHERE proposal_id = $1`, [p.proposal_id])).toEqual([
      { outcome: 'expired' },
    ]);
    expect(await confirm(p.proposal_id, body)).toEqual(res);
    expect((await confirm(p.proposal_id, confirmBody(1))).body).toMatchObject({ code: 'not_pending', status: 'expired' });
  });

  it('refuses cards that are no longer pending', async () => {
    const p = await proposeOk([{ name: 'egg', quantity: 1 }]);
    await db(`UPDATE pantry.proposals SET status = 'rejected' WHERE id = $1`, [p.proposal_id]);
    expect(await confirm(p.proposal_id, confirmBody(1))).toMatchObject({
      status: 409,
      body: { code: 'not_pending', status: 'rejected' },
    });
  });

  it('creates a new item, its batch and purchase event atomically (R21)', async () => {
    const conversationId = randomUUID();
    const question = await propose([{ name: 'Oat Milk', quantity: 1, unit: 'l' }], conversationId);
    expect(parseErrorResult(question)?.code).toBe('unknown_item');
    const p = await proposeOk(
      [{ name: 'Oat Milk', quantity: 1, unit: 'l', new_item: { category: 'dairy', base_unit: 'ml', default_shelf_days: 10 } }],
      conversationId,
    );
    const res = await confirm(p.proposal_id, confirmBody(1));
    expect(res.body).toMatchObject({ status: 'committed', summary: { new_items: ['oat milk'] } });

    const [item] = await db<{ id: string; name: string; category: string; base_unit: string; created_by_op: string }>(
      `SELECT id, name, category, base_unit, created_by_op FROM pantry.items WHERE household_id = $1 AND name = 'oat milk'`,
      [hh.householdId],
    );
    expect(item).toMatchObject({ name: 'oat milk', category: 'dairy', base_unit: 'ml', created_by_op: res.body.operation_id });
    expect(
      await db(`SELECT quantity::int FROM pantry.batches WHERE item_id = $1`, [item!.id]),
    ).toEqual([{ quantity: 1000 }]);
    await assertLedgerConsistent();
  });

  it('learns a package unit once and reuses it on the next intake (R22)', async () => {
    const conversationId = randomUUID();
    const question = await propose([{ name: 'eggs', quantity: 1, unit: 'carton' }], conversationId);
    expect(parseErrorResult(question)).toMatchObject({ code: 'needs_clarification', unit: 'carton' });

    const p = await proposeOk([{ name: 'eggs', quantity: 1, unit: 'carton', unit_conversion: { unit: 'carton', base_qty: 12 } }], conversationId);
    const res = await confirm(p.proposal_id, confirmBody(1));
    expect(res.body).toMatchObject({ summary: { new_conversions: [{ item: 'egg', unit: 'carton', base_qty: 12 }] } });
    expect(await db(`SELECT unit, base_qty::int, created_by_op FROM pantry.unit_conversions WHERE item_id = $1`, [eggId])).toEqual([
      { unit: 'carton', base_qty: 12, created_by_op: res.body.operation_id },
    ]);

    // A later "a carton of eggs" needs no clarification.
    const later = await propose([{ name: 'eggs', quantity: 1, unit: 'cartons' }]);
    expect(parseErrorResult(later)).toBeNull();
    expect((later.structuredContent as { card: { lines: string[] } }).card.lines[0]).toMatch(/^1 carton of eggs \(12 count\)/);
  });

  it('serializes concurrent creation of the same new item: one commits, the other is stale (R27)', async () => {
    const newItem = { category: 'dairy', base_unit: 'ml' };
    const a = await proposeOk([{ name: 'Almond Milk', quantity: 1, unit: 'l', new_item: newItem }]);
    const b = await proposeOk([{ name: 'almond milk', quantity: 2, unit: 'l', new_item: newItem }]);

    const results = await Promise.all([confirm(a.proposal_id, confirmBody(1)), confirm(b.proposal_id, confirmBody(1))]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)?.body).toMatchObject({ code: 'stale_state', reason: 'catalog_changed' });

    const items = await db(`SELECT name FROM pantry.items WHERE household_id = $1 AND lower(name) = 'almond milk'`, [hh.householdId]);
    expect(items).toEqual([{ name: 'almond milk' }]);
    const outcomes = await db<{ outcome: string }>(
      `SELECT outcome FROM pantry.confirmations WHERE proposal_id = ANY ($1::uuid[]) ORDER BY outcome`,
      [[a.proposal_id, b.proposal_id]],
    );
    expect(outcomes.map((o) => o.outcome)).toEqual(['committed', 'stale']);
    const staleId = results[0]?.status === 409 ? a.proposal_id : b.proposal_id;
    expect(await proposalStatus(staleId)).toEqual({ status: 'stale', stale_reason: 'catalog_changed' });

    // Proposing again now resolves the name to the existing item, with no new_item needed.
    const again = await proposeOk([{ name: 'almond milk', quantity: 2, unit: 'l' }]);
    expect((await confirm(again.proposal_id, confirmBody(1))).status).toBe(200);
    await assertLedgerConsistent();
  });

  it('treats singular and plural spellings of a new item as the same item under concurrency', async () => {
    const newItem = { category: 'produce', base_unit: 'count' };
    const a = await proposeOk([{ name: 'Apple', quantity: 3, new_item: newItem }]);
    const b = await proposeOk([{ name: 'apples', quantity: 6, new_item: newItem }]);

    const results = await Promise.all([confirm(a.proposal_id, confirmBody(1)), confirm(b.proposal_id, confirmBody(1))]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)?.body).toMatchObject({ code: 'stale_state', reason: 'catalog_changed' });
    const items = await db(
      `SELECT name FROM pantry.items WHERE household_id = $1 AND name IN ('apple', 'apples')`,
      [hh.householdId],
    );
    expect(items).toEqual([{ name: 'apple' }]);
  });

  it('serializes concurrent learning of the same conversion', async () => {
    const milk = { name: 'milk', quantity: 1, unit: 'jug' };
    const a = await proposeOk([{ ...milk, unit_conversion: { unit: 'jug', base_qty: 2000 } }]);
    const b = await proposeOk([{ ...milk, unit_conversion: { unit: 'jug', base_qty: 1800 } }]);
    const results = await Promise.all([confirm(a.proposal_id, confirmBody(1)), confirm(b.proposal_id, confirmBody(1))]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await db(`SELECT count(*)::int AS n FROM pantry.unit_conversions WHERE unit = 'jug'`)).toEqual([{ n: 1 }]);
  });

  it('returns 404 for an unknown proposal and 400 for malformed requests', async () => {
    expect((await confirm(randomUUID(), confirmBody(1))).status).toBe(404);
    const p = await proposeOk([{ name: 'egg', quantity: 1 }]);
    for (const bad of [
      confirmBody(1, { channel: 'voice_rule' }), // missing utterance
      confirmBody(1, { utterance: 'yes' }), // utterance on a tap
      confirmBody(0),
      confirmBody(1, { request_id: 'not-a-uuid' }),
      confirmBody(1, { channel: 'telepathy' }),
      { version: 1 },
    ]) {
      expect((await confirm(p.proposal_id, bad)).status).toBe(400);
    }
    expect((await confirm('not-a-uuid', confirmBody(1))).status).toBe(400);
    expect(await counts(p.proposal_id)).toEqual({ confirmations: 0, operations: 0 });
  });
});

describe('confirm rate limit (§11.5)', () => {
  it('limits confirms per household, not per caller', async () => {
    const servers = await startServers(mcpTestConfig({ confirmRatePerMinute: 2 }), { log: false });
    const { port } = servers.internal.server.address() as AddressInfo;
    const post = (proposalId: string) =>
      fetch(`http://127.0.0.1:${port}/internal/proposals/${proposalId}/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-service-token': TEST_SERVICE_TOKEN },
        body: JSON.stringify({ version: 1, user_id: 'demo', channel: 'ui_click', request_id: randomUUID() }),
      });
    try {
      const busy = await createHousehold();
      const quiet = await createHousehold();
      const proposalIn = async (householdId: string) => {
        const id = randomUUID();
        await withAdmin((admin) =>
          admin.query(
            `INSERT INTO pantry.proposals (id, household_id, conversation_id, kind, subject_key, input, payload, preconditions, status, expires_at)
             VALUES ($1, $2, $3, 'intake', $4, '{}', '{}', '{}', 'rejected', now())`,
            [id, householdId, randomUUID(), `rl:${id}`],
          ),
        );
        return id;
      };
      const busyProposal = await proposalIn(busy.householdId);
      const statuses = [];
      for (let i = 0; i < 3; i++) statuses.push((await post(busyProposal)).status);
      expect(statuses).toEqual([409, 409, 429]);

      const limited = await post(busyProposal);
      expect(limited.headers.get('retry-after')).not.toBeNull();
      expect((await post(await proposalIn(quiet.householdId))).status).toBe(409);
    } finally {
      await servers.close();
    }
  });
});
