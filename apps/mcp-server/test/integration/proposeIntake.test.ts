// propose_intake over MCP: proposals, idempotency (R9, R11), clarification (R22 first half), errors (R25).
import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { META_CONVERSATION_ID, META_REQUEST_ID, sha256Hex } from '@pantrymos/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningServers, startServers } from '../../src/app.ts';
import { INSPECTOR_CONVERSATION_ID, parseErrorResult } from '../../src/mcp/toolkit.ts';
import {
  connectMcpClient,
  createHousehold,
  createItem,
  type HouseholdFixture,
  mcpTestConfig,
  withAdmin,
} from '../../../../test/fixtures.ts';

interface ProposalOut {
  proposal_id: string;
  version: number;
  kind: string;
  card: { title: string; lines: string[]; warnings: string[]; readback_text: string };
  expires_at: string;
}

describe('propose_intake', () => {
  let servers: RunningServers;
  let hh: HouseholdFixture;
  let client: Client;

  beforeAll(async () => {
    hh = await createHousehold();
    await createItem(hh.householdId, { name: 'egg', default_shelf_days: 21 });
    await createItem(hh.householdId, { name: 'tomato', default_shelf_days: 7 });
    await createItem(hh.householdId, { name: 'milk', base_unit: 'ml', default_shelf_days: 7 });
    servers = await startServers(mcpTestConfig(), { log: false });
    client = await connectMcpClient(servers, hh.token);
    // Caches output schemas, so the SDK client validates every success result below (R25).
    await client.listTools();
  });
  afterAll(async () => {
    await client.close();
    await servers.close();
  });

  const propose = (items: unknown[], ids: { requestId?: string; conversationId?: string } = {}) =>
    client.callTool({
      name: 'propose_intake',
      arguments: { items },
      _meta: {
        [META_REQUEST_ID]: ids.requestId ?? randomUUID(),
        [META_CONVERSATION_ID]: ids.conversationId ?? randomUUID(),
      },
    });
  const out = (res: Awaited<ReturnType<typeof propose>>) => res.structuredContent as unknown as ProposalOut;

  const proposalRow = async (id: string) =>
    withAdmin(async (admin) => {
      const { rows } = await admin.query(
        `SELECT household_id, conversation_id, kind, subject_key, version, status FROM pantry.proposals WHERE id = $1`,
        [id],
      );
      return rows[0];
    });
  const countRows = (table: string) =>
    withAdmin(async (admin) => {
      const { rows } = await admin.query(`SELECT count(*)::int AS n FROM pantry.${table} WHERE household_id = $1`, [
        hh.householdId,
      ]);
      return rows[0].n as number;
    });

  it('creates a pending intake proposal and changes no inventory (B1, E1)', async () => {
    const conversationId = randomUUID();
    const res = await propose(
      [
        { name: 'tomatoes', quantity: 2 },
        { name: 'eggs', quantity: 1, unit: 'dozen' },
      ],
      { conversationId },
    );
    expect(res.isError).toBeFalsy();
    const p = out(res);
    expect(p).toMatchObject({ version: 1, kind: 'intake' });
    expect(p.card.lines).toEqual(['2 tomatoes · bought today, no package date', '1 dozen eggs (12 count) · bought today, no package date']);
    expect(p.card.readback_text).toBe("I'll add 2 tomatoes and 1 dozen eggs, which is 12 eggs. Say confirm, or tell me what to change.");
    expect(await proposalRow(p.proposal_id)).toEqual({
      household_id: hh.householdId,
      conversation_id: conversationId,
      kind: 'intake',
      subject_key: `intake:conv:${conversationId}`,
      version: 1,
      status: 'pending',
    });
    expect(await countRows('batches')).toBe(0);
    expect(await countRows('inventory_events')).toBe(0);
  });

  it('returns the same proposal and version when retried with the same request_id (R9)', async () => {
    const ids = { requestId: randomUUID(), conversationId: randomUUID() };
    const first = await propose([{ name: 'egg', quantity: 6 }], ids);
    const retry = await propose([{ name: 'egg', quantity: 6 }], ids);
    expect(retry).toEqual(first);
    const versions = await withAdmin(async (admin) =>
      admin.query(`SELECT version FROM pantry.proposal_versions WHERE proposal_id = $1`, [out(first).proposal_id]),
    );
    expect(versions.rowCount).toBe(1);
  });

  it('rejects the same request_id with different arguments (R11)', async () => {
    const ids = { requestId: randomUUID(), conversationId: randomUUID() };
    await propose([{ name: 'egg', quantity: 6 }], ids);
    const conflict = await propose([{ name: 'egg', quantity: 7 }], ids);
    expect(conflict.isError).toBe(true);
    expect(parseErrorResult(conflict)).toMatchObject({ code: 'request_conflict' });
  });

  it('versions the card within a conversation: identical plan same version, changed plan +1 (R23)', async () => {
    const conversationId = randomUUID();
    const v1 = out(await propose([{ name: 'egg', quantity: 6 }], { conversationId }));
    const same = out(await propose([{ name: 'eggs', quantity: 6, unit: 'count' }], { conversationId }));
    const v2 = out(await propose([{ name: 'egg', quantity: 3 }], { conversationId }));
    expect(same).toEqual(v1);
    expect(v2).toMatchObject({ proposal_id: v1.proposal_id, version: 2 });
    expect(v2.card.lines[0]).toMatch(/^3 eggs/);
  });

  it('keeps one pending intake card per conversation', async () => {
    const a = out(await propose([{ name: 'egg', quantity: 6 }]));
    const b = out(await propose([{ name: 'egg', quantity: 6 }]));
    expect(a.proposal_id).not.toBe(b.proposal_id);
  });

  it('asks about a package unit, then plans with the answer (R22, first half)', async () => {
    const conversationId = randomUUID();
    const question = await propose([{ name: 'eggs', quantity: 1, unit: 'carton' }], { conversationId });
    expect(question.isError).toBe(true);
    expect(parseErrorResult(question)).toMatchObject({
      code: 'needs_clarification',
      ask: 'How many eggs are in a carton?',
      unit: 'carton',
    });
    expect((question.content as Array<{ text: string }>)[0]?.text).toBe(
      "I don't know how much egg is in a carton. How many eggs are in a carton?",
    );

    const answered = out(
      await propose([{ name: 'eggs', quantity: 1, unit: 'carton', unit_conversion: { unit: 'carton', base_qty: 12 } }], {
        conversationId,
      }),
    );
    expect(answered.card.warnings).toEqual(['Saved: 1 carton = 12 eggs']);
  });

  it('reports an unknown item and creates nothing until the user answers', async () => {
    const conversationId = randomUUID();
    const before = await countRows('proposals');
    const res = await propose([{ name: 'oat milk', quantity: 1, unit: 'l' }], { conversationId });
    expect(parseErrorResult(res)).toMatchObject({
      code: 'unknown_item',
      required: ['items[0].new_item.category', 'items[0].new_item.base_unit'],
      suggestions: ['milk'],
    });
    expect(await countRows('proposals')).toBe(before);
    expect(await countRows('items')).toBe(3);
  });

  it('replays a stored business error for a retried request', async () => {
    const ids = { requestId: randomUUID(), conversationId: randomUUID() };
    const first = await propose([{ name: 'oat milk', quantity: 1, unit: 'l' }], ids);
    const retry = await propose([{ name: 'oat milk', quantity: 1, unit: 'l' }], ids);
    expect(retry).toEqual(first);
  });

  it('requires _meta request and conversation ids', async () => {
    const noRequest = await client.callTool({
      name: 'propose_intake',
      arguments: { items: [{ name: 'egg', quantity: 1 }] },
      _meta: { [META_CONVERSATION_ID]: randomUUID() },
    });
    expect(parseErrorResult(noRequest)).toMatchObject({ code: 'request_id_required' });
    const noConversation = await client.callTool({
      name: 'propose_intake',
      arguments: { items: [{ name: 'egg', quantity: 1 }] },
      _meta: { [META_REQUEST_ID]: randomUUID() },
    });
    expect(parseErrorResult(noConversation)).toMatchObject({ code: 'conversation_id_required' });
  });

  it('rejects malformed input at the schema (caps from §11.5)', async () => {
    const tooMany = await propose(Array.from({ length: 21 }, () => ({ name: 'egg', quantity: 1 })));
    expect(tooMany.isError).toBe(true);
    const negative = await propose([{ name: 'egg', quantity: -1 }]);
    expect(negative.isError).toBe(true);
    const huge = await propose([{ name: 'egg', quantity: 100_001 }]);
    expect(huge.isError).toBe(true);
    const badDate = await propose([{ name: 'egg', quantity: 1, purchased_at: 'yesterday' }]);
    expect(badDate.isError).toBe(true);
  });
});

describe('propose_intake with ALLOW_ANON_WRITES (dev only)', () => {
  it('accepts calls without _meta and routes them to the Inspector conversation', async () => {
    const hh = await createHousehold();
    await createItem(hh.householdId, { name: 'egg' });
    const servers = await startServers(mcpTestConfig({ allowAnonWrites: true }), { log: false });
    const client = await connectMcpClient(servers, hh.token);
    try {
      const res = await client.callTool({ name: 'propose_intake', arguments: { items: [{ name: 'egg', quantity: 2 }] } });
      expect(res.isError).toBeFalsy();
      const { proposal_id } = res.structuredContent as { proposal_id: string };
      const row = await withAdmin(async (admin) =>
        admin.query(`SELECT conversation_id FROM pantry.proposals WHERE id = $1`, [proposal_id]),
      );
      expect(row.rows[0].conversation_id).toBe(INSPECTOR_CONVERSATION_ID);
    } finally {
      await client.close();
      await servers.close();
    }
  });
});

describe('propose_* rate limit (§11.5)', () => {
  it('limits card proposals per client token, leaving other tools and clients alone', async () => {
    const hh = await createHousehold();
    await createItem(hh.householdId, { name: 'egg' });
    const servers = await startServers(mcpTestConfig({ proposeRatePerMinute: 2 }), { log: false });
    const client = await connectMcpClient(servers, hh.token);
    try {
      const propose = () =>
        client.callTool({
          name: 'propose_intake',
          arguments: { items: [{ name: 'egg', quantity: 1 }] },
          _meta: { [META_REQUEST_ID]: randomUUID(), [META_CONVERSATION_ID]: randomUUID() },
        });
      expect(parseErrorResult(await propose())).toBeNull();
      expect(parseErrorResult(await propose())).toBeNull();
      const limited = parseErrorResult(await propose());
      expect(limited).toMatchObject({ code: 'rate_limited' });
      expect(limited?.retry_after).toBeGreaterThan(0);
      // Reads are not proposals.
      expect(parseErrorResult(await client.callTool({ name: 'list_inventory', arguments: {} }))).toBeNull();

      // Another client token has its own allowance.
      const otherToken = await withAdmin(async (admin) => {
        const token = randomUUID().replaceAll('-', '');
        await admin.query(
          `INSERT INTO pantry.api_clients (id, household_id, name, token_hash) VALUES ($1, $2, 'second', $3)`,
          [randomUUID(), hh.householdId, sha256Hex(token)],
        );
        return token;
      });
      const other = await connectMcpClient(servers, otherToken);
      const res = await other.callTool({
        name: 'propose_intake',
        arguments: { items: [{ name: 'egg', quantity: 1 }] },
        _meta: { [META_REQUEST_ID]: randomUUID(), [META_CONVERSATION_ID]: randomUUID() },
      });
      expect(parseErrorResult(res)).toBeNull();
      await other.close();
    } finally {
      await client.close();
      await servers.close();
    }
  });
});
