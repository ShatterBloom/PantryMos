// Security tests S1–S5 (+ MCP rate limit) — IMPLEMENTATION_PLAN §9.2, §11.
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildInternalApp, buildMcpApp, type RunningServers, startServers } from '../../src/app.ts';
import type { Pool } from '../../src/db/pool.ts';
import {
  createHousehold,
  type HouseholdFixture,
  INITIALIZE_BODY,
  INSPECTOR_ORIGIN,
  MCP_HEADERS,
  mcpTestConfig,
  TEST_SERVICE_TOKEN,
} from '../../../../test/fixtures.ts';

const urlOf = (app: RunningServers['mcp']) => {
  const { address, port } = app.server.address() as AddressInfo;
  return `http://${address}:${port}`;
};

describe('mcp-server security', () => {
  let servers: RunningServers;
  let hh: HouseholdFixture;
  let mcpUrl: string;
  let internalUrl: string;

  beforeAll(async () => {
    hh = await createHousehold();
    servers = await startServers(mcpTestConfig(), { log: false });
    mcpUrl = urlOf(servers.mcp);
    internalUrl = urlOf(servers.internal);
  });
  afterAll(async () => servers.close());

  const initialize = (headers: Record<string, string> = {}, body: unknown = INITIALIZE_BODY) =>
    fetch(`${mcpUrl}/mcp`, { method: 'POST', headers: { ...MCP_HEADERS, ...headers }, body: JSON.stringify(body) });

  describe('S1 bearer authentication', () => {
    it('rejects a request without a token', async () => {
      expect((await initialize()).status).toBe(401);
    });
    it('rejects an unknown token', async () => {
      expect((await initialize({ authorization: 'Bearer not-a-real-token' })).status).toBe(401);
    });
    it('rejects a revoked token', async () => {
      expect((await initialize({ authorization: `Bearer ${hh.revokedToken}` })).status).toBe(401);
    });
    it('accepts a valid token', async () => {
      const res = await initialize({ authorization: `Bearer ${hh.token}` });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { result: { protocolVersion: string } };
      expect(body.result.protocolVersion).toBe('2025-11-25');
    });
  });

  describe('S2 Origin validation', () => {
    it('rejects a disallowed Origin even with a valid token', async () => {
      const res = await initialize({ authorization: `Bearer ${hh.token}`, origin: 'https://evil.example' });
      expect(res.status).toBe(403);
    });
    it('accepts an allow-listed Origin', async () => {
      const res = await initialize({ authorization: `Bearer ${hh.token}`, origin: INSPECTOR_ORIGIN });
      expect(res.status).toBe(200);
    });
  });

  describe('S3 internal API authentication', () => {
    it('rejects a missing service token', async () => {
      expect((await fetch(`${internalUrl}/internal/health`)).status).toBe(401);
    });
    it('rejects a wrong service token', async () => {
      const res = await fetch(`${internalUrl}/internal/health`, { headers: { 'x-service-token': 'wrong-token-wrong-token' } });
      expect(res.status).toBe(401);
    });
    it('accepts the service token', async () => {
      const res = await fetch(`${internalUrl}/internal/health`, { headers: { 'x-service-token': TEST_SERVICE_TOKEN } });
      expect(res.status).toBe(200);
    });
  });

  describe('S4 listener isolation', () => {
    it('binds both listeners to loopback only', () => {
      expect((servers.mcp.server.address() as AddressInfo).address).toBe('127.0.0.1');
      expect((servers.internal.server.address() as AddressInfo).address).toBe('127.0.0.1');
    });
    it('does not serve internal routes on the MCP listener', async () => {
      const res = await fetch(`${mcpUrl}/internal/health`, { headers: { 'x-service-token': TEST_SERVICE_TOKEN } });
      expect(res.status).toBe(404);
    });
    it('does not serve MCP on the internal listener', async () => {
      const res = await fetch(`${internalUrl}/mcp`, {
        method: 'POST',
        headers: { ...MCP_HEADERS, 'x-service-token': TEST_SERVICE_TOKEN, authorization: `Bearer ${hh.token}` },
        body: JSON.stringify(INITIALIZE_BODY),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('S5 request size limit', () => {
    it('rejects bodies over 64 KB', async () => {
      const big = { ...INITIALIZE_BODY, params: { ...INITIALIZE_BODY.params, padding: 'x'.repeat(70 * 1024) } };
      const res = await initialize({ authorization: `Bearer ${hh.token}` }, big);
      expect(res.status).toBe(413);
    });
  });

  it('rejects GET /mcp (stateless server, no SSE stream)', async () => {
    const res = await fetch(`${mcpUrl}/mcp`, { headers: { authorization: `Bearer ${hh.token}` } });
    expect(res.status).toBe(405);
  });
});

describe('mcp-server faults', () => {
  // A database that fails the way Postgres does, naming what it failed on.
  const broken = { query: async () => Promise.reject(new Error('relation "pantry.batches" does not exist')) } as unknown as Pool;

  it('answers 500 without the fault on either listener', async () => {
    const mcp = await buildMcpApp(mcpTestConfig(), broken, false);
    const internal = await buildInternalApp(mcpTestConfig(), broken, false);
    try {
      const replies = [
        await mcp.inject({ method: 'POST', url: '/mcp', headers: { ...MCP_HEADERS, authorization: 'Bearer pmk_x' }, payload: INITIALIZE_BODY }),
        await internal.inject({ method: 'GET', url: '/internal/health', headers: { 'x-service-token': TEST_SERVICE_TOKEN } }),
      ];
      for (const reply of replies) {
        expect(reply.statusCode).toBe(500);
        expect(reply.json()).toEqual({ error: 'internal_error' });
      }
    } finally {
      await Promise.all([mcp.close(), internal.close()]);
    }
  });
});

describe('mcp-server rate limit', () => {
  let servers: RunningServers;
  let hh: HouseholdFixture;

  beforeAll(async () => {
    hh = await createHousehold();
    servers = await startServers(mcpTestConfig({ mcpRatePerMinute: 3 }), { log: false });
  });
  afterAll(async () => servers.close());

  it('returns 429 with Retry-After once the per-client limit is exceeded', async () => {
    const url = `${urlOf(servers.mcp)}/mcp`;
    const statuses: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < 4; i++) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...MCP_HEADERS, authorization: `Bearer ${hh.token}` },
        body: JSON.stringify(INITIALIZE_BODY),
      });
      statuses.push(res.status);
      if (res.status === 429) retryAfter = res.headers.get('retry-after');
      await res.arrayBuffer();
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(retryAfter).not.toBeNull();
  });
});
