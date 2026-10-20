// Spike V3 (MCP half): agent ↔ MCP server ↔ internal API, with role-separated DB access.
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningServers, startServers } from '@pantrymos/mcp-server';
import { buildAgentApp } from '../../src/app.ts';
import { createPool } from '../../src/db.ts';
import { createHousehold, mcpTestConfig, TEST_SERVICE_TOKEN } from '../../../../test/fixtures.ts';
import { TEST_AGENT_DB_URL } from '../../../../test/env.ts';

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
    expect(res.json()).toEqual({
      ok: true,
      db: true,
      mcp: { ok: true, tools: expect.arrayContaining(['list_inventory']) },
      internal: true,
    });
  });
});

describe('agent health when dependencies are down', () => {
  let agent: FastifyInstance;
  let pool: pg.Pool;

  beforeAll(async () => {
    // Port 1 on loopback refuses connections; the pool points at a database that does not exist.
    pool = createPool(TEST_AGENT_DB_URL.replace(/\/[^/?]+(\?|$)/, '/pantrymos_missing$1'));
    agent = await buildAgentApp(
      {
        databaseUrl: 'unused',
        bindHost: '127.0.0.1',
        port: 0,
        mcpUrl: 'http://127.0.0.1:1/mcp',
        internalUrl: 'http://127.0.0.1:1',
        mcpToken: 'unused-token-0123456789',
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
  });

  it('returns 503 and names every failed dependency', async () => {
    const res = await agent.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, db: false, mcp: { ok: false, tools: [] }, internal: false });
  });
});
