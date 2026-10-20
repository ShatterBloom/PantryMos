// GET /internal/proposals/:id: the card as it stands, for the agent's read-back (§8.5).
import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type RunningServers, startServers } from '../../src/app.ts';
import {
  callWrite,
  confirmCard,
  connectMcpClient,
  createDemoKitchen,
  type DemoKitchen,
  internalCall,
  mcpTestConfig,
  withAdmin,
} from '../../../../test/fixtures.ts';

describe('GET /internal/proposals/:id', () => {
  let servers: RunningServers;
  beforeAll(async () => {
    servers = await startServers(mcpTestConfig(), { log: false });
  });
  afterAll(async () => servers.close());

  let kitchen: DemoKitchen;
  let client: Client;
  beforeEach(async () => {
    kitchen = await createDemoKitchen();
    client = await connectMcpClient(servers, kitchen.token);
    return () => client.close();
  });

  const view = (id: string) => internalCall(servers, `/internal/proposals/${id}`, undefined, 'GET');

  it('returns the current version, its card and conversation, then its new status', async () => {
    const conversationId = randomUUID();
    const p = (await callWrite(client, 'propose_intake', { items: [{ name: 'egg', quantity: 6 }] }, { conversationId }))
      .structuredContent as { proposal_id: string; card: unknown; expires_at: string };
    expect(await view(p.proposal_id)).toEqual({
      status: 200,
      body: {
        proposal_id: p.proposal_id,
        kind: 'intake',
        status: 'pending',
        version: 1,
        conversation_id: conversationId,
        card: p.card,
        expires_at: p.expires_at,
      },
    });
    expect((await confirmCard(servers, p, 1)).status).toBe(200);
    expect((await view(p.proposal_id)).body.status).toBe('committed');
  });

  it('reads a pending card past its expiry as expired', async () => {
    const p = (await callWrite(client, 'propose_intake', { items: [{ name: 'egg', quantity: 6 }] })).structuredContent as {
      proposal_id: string;
    };
    await withAdmin((admin) => admin.query(`UPDATE pantry.proposals SET expires_at = now() - interval '1 s' WHERE id = $1`, [p.proposal_id]));
    expect((await view(p.proposal_id)).body.status).toBe('expired');
  });

  it('is 404 for an unknown or malformed id, and needs the service token', async () => {
    expect((await view(randomUUID())).status).toBe(404);
    expect((await view('not-a-uuid')).status).toBe(404);
    const { port } = servers.internal.server.address() as { port: number };
    expect((await fetch(`http://127.0.0.1:${port}/internal/proposals/${randomUUID()}`)).status).toBe(401);
  });
});
