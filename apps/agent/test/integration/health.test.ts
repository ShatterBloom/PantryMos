// Spike V3 (MCP half): agent ↔ MCP server ↔ internal API, with role-separated DB access.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningServers, startServers } from '@pantrymos/mcp-server';
import { createHousehold, mcpTestConfig } from '../../../../test/fixtures.ts';
import { TEST_AGENT_DB_URL } from '../../../../test/env.ts';
import { startAgent, type TestAgent } from '../fixtures.ts';

describe('agent health', () => {
  let servers: RunningServers;
  let agent: TestAgent;

  beforeAll(async () => {
    const hh = await createHousehold();
    servers = await startServers(mcpTestConfig(), { log: false });
    agent = await startAgent(servers, hh);
  });
  afterAll(async () => {
    await agent.close();
    await servers.close();
  });

  it('reports database, MCP and internal API as healthy', async () => {
    const res = await agent.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      db: true,
      mcp: { ok: true, tools: expect.arrayContaining(['list_inventory']) },
      internal: true,
    });
  });
});

describe('agent health when dependencies are down', () => {
  let servers: RunningServers;
  let agent: TestAgent;

  beforeAll(async () => {
    const hh = await createHousehold();
    servers = await startServers(mcpTestConfig(), { log: false });
    // Port 1 on loopback refuses connections; the database does not exist.
    agent = await startAgent(servers, hh, {
      config: {
        databaseUrl: TEST_AGENT_DB_URL.replace(/\/[^/?]+(\?|$)/, '/pantrymos_missing$1'),
        mcpUrl: 'http://127.0.0.1:1/mcp',
        internalUrl: 'http://127.0.0.1:1',
      },
    });
  });
  afterAll(async () => {
    await agent.close();
    await servers.close();
  });

  it('returns 503 and names every failed dependency', async () => {
    const res = await agent.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, db: false, mcp: { ok: false, tools: [] }, internal: false });
  });
});
