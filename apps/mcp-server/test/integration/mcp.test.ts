// MCP round trip through the official SDK client: tool contracts (§7.3), household isolation (S7)
// and the _meta transport (spike V2a).
import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningServers, startServers } from '../../src/app.ts';
import {
  connectMcpClient,
  createBatch,
  createHousehold,
  createItem,
  type HouseholdFixture,
  mcpTestConfig,
} from '../../../../test/fixtures.ts';

/** Annotations per §7.3. Extended as tools are added. */
const EXPECTED_ANNOTATIONS: Record<string, { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean }> = {
  list_inventory: { readOnlyHint: true },
  expiring_soon: { readOnlyHint: true },
  propose_intake: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  start_cooking: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  get_session: { readOnlyHint: true },
  next_step: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  substitute: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  skip_ingredient: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  cancel_cooking: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  propose_consumption: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  suggest_recipes: { readOnlyHint: true },
  list_recent_operations: { readOnlyHint: true },
  propose_consumption_revision: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};

describe('MCP server over Streamable HTTP', () => {
  let servers: RunningServers;
  let hh: HouseholdFixture;
  let other: HouseholdFixture;
  let client: Client;

  beforeAll(async () => {
    hh = await createHousehold();
    other = await createHousehold();
    servers = await startServers(mcpTestConfig(), { log: false });
    for (const [household, quantity] of [
      [hh, 12],
      [other, 99],
    ] as const) {
      const egg = await createItem(household.householdId, { name: 'egg', aliases: ['eggs'] });
      await createBatch(household.householdId, egg, {
        quantity,
        purchased_at: '2026-10-10',
        package_date: '2026-10-18',
        package_date_type: 'best_by',
      });
    }
    client = await connectMcpClient(servers, hh.token);
  });
  afterAll(async () => {
    await client.close();
    await servers.close();
  });

  it('lists exactly the expected tools, each with honest annotations and an output schema', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(EXPECTED_ANNOTATIONS).sort());
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({ ...EXPECTED_ANNOTATIONS[tool.name], openWorldHint: false });
      expect(tool.outputSchema).toBeDefined();
      expect(tool.description?.length).toBeGreaterThan(40);
    }
  });

  it('never exposes a commit tool or a household_id argument (H2, I9)', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.name).not.toMatch(/confirm|commit/);
      expect(JSON.stringify(tool.inputSchema)).not.toContain('household_id');
      expect(JSON.stringify(tool.inputSchema)).not.toContain('request_id');
    }
  });

  it('returns only the caller household inventory, with server date labels', async () => {
    const res = await client.callTool({ name: 'list_inventory', arguments: { item: 'Eggs' } });
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent as { items: Array<{ total: number; batches: Array<{ date_label: string }> }> };
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

  it('reports invalid arguments as a tool error, not a crash', async () => {
    const res = await client.callTool({ name: 'expiring_soon', arguments: { within_days: 0 } });
    expect(res.isError).toBe(true);
    const tooLong = await client.callTool({ name: 'list_inventory', arguments: { item: 'x'.repeat(61) } });
    expect(tooLong.isError).toBe(true);
    const control = await client.callTool({ name: 'list_inventory', arguments: { item: 'egg\u0000' } });
    expect(control.isError).toBe(true);
  });
});
