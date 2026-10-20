// propose_consumption: pinned FEFO allocation, session transitions and card versions
// (story D3, FR-14, FR-17; R1 propose half, R23).
import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type RunningServers, startServers } from '../../src/app.ts';
import { addDays, formatShort } from '../../src/domain/dates.ts';
import { parseErrorResult } from '../../src/mcp/toolkit.ts';
import {
  callWrite,
  connectMcpClient,
  createBatch,
  createDemoKitchen,
  type DemoKitchen,
  mcpTestConfig,
  PASTA_STOCK,
  stockKitchen,
  todayIn,
  withAdmin,
} from '../../../../test/fixtures.ts';

interface Proposed {
  proposal_id: string;
  version: number;
  kind: string;
  card: { title: string; lines: string[]; warnings: string[]; readback_text: string };
}

describe('propose_consumption', () => {
  let servers: RunningServers;
  beforeAll(async () => {
    servers = await startServers(mcpTestConfig(), { log: false });
  });
  afterAll(async () => servers.close());

  let kitchen: DemoKitchen;
  let client: Client;
  let today: string;
  let milkA: string;
  let milkB: string;
  let sessionId: string;
  const conversationId = randomUUID();

  beforeEach(async () => {
    kitchen = await createDemoKitchen();
    client = await connectMcpClient(servers, kitchen.token);
    await client.listTools();
    today = await todayIn('America/Los_Angeles');
    const { milk: _milk, ...rest } = PASTA_STOCK;
    await stockKitchen(kitchen, rest);
    // Two milk cartons: A expires first, so FEFO takes from A before B.
    milkB = await createBatch(kitchen.householdId, kitchen.items.milk!, {
      quantity: 1000, purchased_at: addDays(today, -1), package_date: addDays(today, 8), package_date_type: 'best_by',
    });
    milkA = await createBatch(kitchen.householdId, kitchen.items.milk!, {
      quantity: 1000, purchased_at: addDays(today, -3), package_date: addDays(today, 2), package_date_type: 'best_by',
    });
    const started = await callWrite(client, 'start_cooking', { recipe_name: 'creamy spinach pasta' });
    sessionId = (started.structuredContent as { session_id: string }).session_id;
    return () => client.close();
  });

  const propose = (args: Record<string, unknown> = {}, requestId?: string) =>
    callWrite(client, 'propose_consumption', args, { conversationId, ...(requestId ? { requestId } : {}) });
  const ok = async (args: Record<string, unknown> = {}) => {
    const res = await propose(args);
    expect(parseErrorResult(res)).toBeNull();
    return res.structuredContent as unknown as Proposed;
  };
  const proposalRow = async (id: string) =>
    withAdmin(async (admin) => (await admin.query(`SELECT * FROM pantry.proposals WHERE id = $1`, [id])).rows[0]);
  const sessionRow = async () =>
    withAdmin(async (admin) =>
      (await admin.query(`SELECT state, state_version FROM pantry.cooking_sessions WHERE id = $1`, [sessionId])).rows[0],
    );
  const batchVersion = async (id: string) =>
    withAdmin(async (admin) => (await admin.query(`SELECT version FROM pantry.batches WHERE id = $1`, [id])).rows[0].version);

  it('creates a card from the planned usage and waits for confirmation, changing no inventory (D3, E1)', async () => {
    const p = await ok();
    expect(p).toMatchObject({ version: 1, kind: 'consume' });
    expect(p.card.title).toBe('What you used');
    expect(p.card.readback_text).toBe(
      "I'll record 20 grams of butter, 2 garlic cloves, 250 milliliters of milk, 40 grams of parmesan, 300 grams of pasta, 2 scallions and 150 grams of spinach. Say confirm, or tell me what to change.",
    );
    expect(await sessionRow()).toEqual({ state: 'awaiting_confirmation', state_version: 2 });

    const row = await proposalRow(p.proposal_id);
    expect(row).toMatchObject({
      kind: 'consume',
      subject_key: `consume:session:${sessionId}`,
      target_session_id: sessionId,
      conversation_id: conversationId,
      status: 'pending',
    });
    expect(row.preconditions.session).toEqual({ id: sessionId, state: 'awaiting_confirmation', state_version: 2 });
    const events = await withAdmin(async (admin) =>
      admin.query(`SELECT 1 FROM pantry.inventory_events WHERE household_id = $1 AND reason <> 'purchase'`, [kitchen.householdId]),
    );
    expect(events.rowCount).toBe(0);
  });

  it('pins a FEFO allocation across batches and their versions (R1, FR-17)', async () => {
    const p = await ok({ overrides: [{ item: 'milk', quantity: 1200 }] });
    const row = await proposalRow(p.proposal_id);
    expect(row.payload.allocation.filter((a: { item_id: string }) => a.item_id === kitchen.items.milk)).toEqual([
      { batch_id: milkA, item_id: kitchen.items.milk, delta: -1000 },
      { batch_id: milkB, item_id: kitchen.items.milk, delta: -200 },
    ]);
    expect(row.preconditions.batches).toContainEqual({ id: milkA, version: await batchVersion(milkA) });
    expect(row.preconditions.batches).toContainEqual({ id: milkB, version: await batchVersion(milkB) });
    // One card line per batch, each with its date label.
    expect(p.card.lines).toContain(`1000 milliliters of milk · best by ${formatShort(addDays(today, 2))} (from package)`);
    expect(p.card.lines).toContain(`200 milliliters of milk · best by ${formatShort(addDays(today, 8))} (from package)`);
  });

  it('returns the same version for an identical re-propose, without touching the session (R23)', async () => {
    const first = await ok();
    const again = await ok();
    expect(again).toEqual(first);
    expect(await sessionRow()).toEqual({ state: 'awaiting_confirmation', state_version: 2 });
  });

  it('appends a version when the user changes an amount, keeping every version (R23, R29)', async () => {
    const v1 = await ok();
    const v2 = await ok({ overrides: [{ item: 'pasta', quantity: 250 }] });
    expect(v2).toMatchObject({ proposal_id: v1.proposal_id, version: 2 });
    expect(v2.card.readback_text).toContain('250 grams of pasta');
    expect(await sessionRow()).toEqual({ state: 'awaiting_confirmation', state_version: 3 });
    const versions = await withAdmin(async (admin) =>
      admin.query(`SELECT version FROM pantry.proposal_versions WHERE proposal_id = $1 ORDER BY version`, [v1.proposal_id]),
    );
    expect(versions.rows).toEqual([{ version: 1 }, { version: 2 }]);
  });

  it('removes a line set to 0 and adds an item that was not planned', async () => {
    await stockKitchen(kitchen, { egg: 6 });
    const p = await ok({ overrides: [{ item: 'parmesan', quantity: 0 }, { item: 'eggs', quantity: 2 }] });
    expect(p.card.readback_text).not.toContain('parmesan');
    expect(p.card.readback_text).toContain('2 eggs');
  });

  it('leaves out skipped ingredients', async () => {
    await callWrite(client, 'skip_ingredient', { item: 'parmesan' });
    expect((await ok()).card.readback_text).not.toContain('parmesan');
  });

  it('refuses more than the stock and unknown items', async () => {
    expect(parseErrorResult(await propose({ overrides: [{ item: 'milk', quantity: 5000 }] }))).toMatchObject({
      code: 'insufficient_stock',
      item: 'milk',
      need: 5000,
      have: 2000,
    });
    expect(parseErrorResult(await propose({ overrides: [{ item: 'unobtainium', quantity: 1 }] }))?.code).toBe('unknown_item');
    expect((await sessionRow()).state).toBe('cooking');
  });

  it('starts a fresh card after a plan change superseded the old one', async () => {
    const first = await ok();
    await callWrite(client, 'skip_ingredient', { item: 'parmesan' });
    expect((await proposalRow(first.proposal_id)).status).toBe('superseded');
    const second = await ok();
    expect(second.proposal_id).not.toBe(first.proposal_id);
    expect(second.version).toBe(1);
  });

  it('replays a retried request and requires an active session', async () => {
    const requestId = randomUUID();
    expect(await propose({}, requestId)).toEqual(await propose({}, requestId));
    await callWrite(client, 'cancel_cooking', {});
    expect(parseErrorResult(await propose())?.code).toBe('no_active_session');
  });
});
