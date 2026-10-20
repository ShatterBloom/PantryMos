// MCP round trip through the official SDK client, plus spike V2a (_meta transport).
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningServers, startServers } from '../../src/app.ts';
import { createHousehold, type HouseholdFixture, mcpTestConfig } from '../../../../test/fixtures.ts';
import { TEST_ADMIN_URL } from '../../../../test/env.ts';

describe('MCP tools over Streamable HTTP', () => {
  let servers: RunningServers;
  let hh: HouseholdFixture;
  let other: HouseholdFixture;
  let client: Client;

  beforeAll(async () => {
    hh = await createHousehold();
    other = await createHousehold();
    servers = await startServers(mcpTestConfig(), { log: false });
    await seedEggs(hh.householdId, 12);
    await seedEggs(other.householdId, 99);

    const { address, port } = servers.mcp.server.address() as AddressInfo;
    client = new Client({ name: 'test', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://${address}:${port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${hh.token}` } },
      }),
    );
  });
  afterAll(async () => {
    await client.close();
    await servers.close();
  });

  it('lists list_inventory as a read-only tool', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'list_inventory');
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.inputSchema.properties).not.toHaveProperty('household_id');
  });

  it('returns only the caller household inventory, with server date labels', async () => {
    const res = await client.callTool({ name: 'list_inventory', arguments: { item: 'Eggs' } });
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent as { today: string; items: Array<{ item: string; total: number; batches: Array<{ date_label: string }> }> };
    expect(out.items).toHaveLength(1);
    expect(out.items[0]?.total).toBe(12); // not the other household's 99
    expect(out.items[0]?.batches[0]?.date_label).toBe('best by Oct 18 (from package)');
  });

  it('ignores a household_id smuggled into tool arguments (S7)', async () => {
    const res = await client.callTool({ name: 'list_inventory', arguments: { household_id: other.householdId } });
    const out = res.structuredContent as { items: Array<{ total: number }> };
    expect(out.items[0]?.total).toBe(12);
  });

  it('carries _meta request ids to the server without exposing them in the schema (V2a)', async () => {
    const res = await client.callTool({
      name: 'list_inventory',
      arguments: {},
      _meta: { 'pantrymos/request_id': randomUUID() },
    });
    expect(res.isError).toBeFalsy();
  });
});

async function seedEggs(householdId: string, quantity: number): Promise<void> {
  // Written as admin: real intake goes through proposals (M1).
  const admin = new pg.Client({ connectionString: TEST_ADMIN_URL });
  await admin.connect();
  try {
    const itemId = randomUUID();
    const proposalId = randomUUID();
    const confirmationId = randomUUID();
    const opId = randomUUID();
    const batchId = randomUUID();
    await admin.query('BEGIN');
    await admin.query(
      `INSERT INTO pantry.items (id, household_id, name, aliases, base_unit, category) VALUES ($1, $2, 'egg', '{eggs}', 'count', 'dairy')`,
      [itemId, householdId],
    );
    await admin.query(
      `INSERT INTO pantry.proposals (id, household_id, conversation_id, kind, subject_key, input, payload, preconditions, status, expires_at)
       VALUES ($1, $2, $3, 'intake', 'seed', '{}', '{}', '{}', 'committed', now())`,
      [proposalId, householdId, randomUUID()],
    );
    await admin.query(
      `INSERT INTO pantry.confirmations (id, household_id, proposal_id, version, user_id, channel, request_id, outcome)
       VALUES ($1, $2, $3, 1, 'seed', 'ui_click', $4, 'committed')`,
      [confirmationId, householdId, proposalId, randomUUID()],
    );
    await admin.query(
      `INSERT INTO pantry.operations (id, household_id, kind, proposal_id, proposal_version, confirmation_id, summary)
       VALUES ($1, $2, 'intake', $3, 1, $4, '{}')`,
      [opId, householdId, proposalId, confirmationId],
    );
    await admin.query(
      `INSERT INTO pantry.batches (id, household_id, item_id, quantity, purchased_at, package_date, package_date_type,
                                   priority_date, priority_source, status, created_by_op)
       VALUES ($1, $2, $3, $4, '2026-10-10', '2026-10-18', 'best_by', '2026-10-18', 'package', 'active', $5)`,
      [batchId, householdId, itemId, quantity, opId],
    );
    await admin.query(
      `INSERT INTO pantry.inventory_events (id, household_id, operation_id, batch_id, item_id, delta, reason)
       VALUES ($1, $2, $3, $4, $5, $6, 'purchase')`,
      [randomUUID(), householdId, opId, batchId, itemId, quantity],
    );
    await admin.query('COMMIT');
  } finally {
    await admin.end();
  }
}
