// Spike V3 (MCP half): agent ↔ MCP server ↔ internal API, with role-separated DB access.
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningServers, startServers } from '@pantrymos/mcp-server';
import { buildAgentApp } from '../src/app.ts';
import { createPool } from '../src/db.ts';
import { createHousehold, mcpTestConfig, TEST_SERVICE_TOKEN } from '../../../test/fixtures.ts';
import { TEST_AGENT_DB_URL } from '../../../test/env.ts';

describe('agent health', () => {
  let servers: RunningServers;
  let agent: FastifyInstance;
  let pool: pg.Pool;

  beforeAll(async () => {
    const hh = await createHousehold();
    servers = await startServers(mcpTestConfig(), { log: false });
    const mcpAddr = servers.mcp.server.address() as AddressInfo;
    const internalAddr = servers.internal.server.address() as AddressInfo;
    pool = createPool(TEST_AGENT_DB_URL);
    agent = await buildAgentApp(
      {
        databaseUrl: TEST_AGENT_DB_URL,
        bindHost: '127.0.0.1',
        port: 0,
        mcpUrl: `http://127.0.0.1:${mcpAddr.port}/mcp`,
        internalUrl: `http://127.0.0.1:${internalAddr.port}`,
        mcpToken: hh.token,
        serviceToken: TEST_SERVICE_TOKEN,
        bodyLimitBytes: 64 * 1024,
      },
      pool,
      false,
    );
  });
  afterAll(async () => {
    await agent.close();
    await pool.end();
    await servers.close();
  });

  it('reports database, MCP and internal API as healthy', async () => {
    const res = await agent.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, db: true, mcp: { ok: true, tools: ['list_inventory'] }, internal: true });
  });
});
