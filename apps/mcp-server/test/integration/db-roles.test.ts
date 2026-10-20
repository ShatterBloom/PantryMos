// Schema ownership and append-only guarantees enforced by Postgres privileges (§1, I3).
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_AGENT_DB_URL, TEST_MCP_DB_URL } from '../../../../test/env.ts';

describe('database roles', () => {
  const mcp = new pg.Client({ connectionString: TEST_MCP_DB_URL });
  const agent = new pg.Client({ connectionString: TEST_AGENT_DB_URL });

  beforeAll(async () => {
    await mcp.connect();
    await agent.connect();
  });
  afterAll(async () => {
    await mcp.end();
    await agent.end();
  });

  it('pantry_mcp reads pantry but not agent', async () => {
    await expect(mcp.query('SELECT 1 FROM pantry.items LIMIT 1')).resolves.toBeDefined();
    await expect(mcp.query('SELECT 1 FROM agent.conversations LIMIT 1')).rejects.toThrow(/permission denied/);
  });

  it('pantry_agent reads agent but not pantry', async () => {
    await expect(agent.query('SELECT 1 FROM agent.conversations LIMIT 1')).resolves.toBeDefined();
    await expect(agent.query('SELECT 1 FROM pantry.items LIMIT 1')).rejects.toThrow(/permission denied/);
  });

  it('inventory_events and proposal_versions are append-only for pantry_mcp', async () => {
    await expect(mcp.query('UPDATE pantry.inventory_events SET delta = delta WHERE false')).rejects.toThrow(/permission denied/);
    await expect(mcp.query('DELETE FROM pantry.inventory_events WHERE false')).rejects.toThrow(/permission denied/);
    await expect(mcp.query('UPDATE pantry.proposal_versions SET version = version WHERE false')).rejects.toThrow(
      /permission denied/,
    );
  });

  it('item names are unique case-insensitively', async () => {
    const indexes = await mcp.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'pantry' AND indexname = 'items_name_ci'`,
    );
    expect(indexes.rows[0]?.indexdef).toMatch(/lower\(name\)/);
  });
});
