// Rejecting cards (§4.4, story B1 "Given I reject, then nothing is written").
import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type RunningServers, startServers } from '../../src/app.ts';
import { parseErrorResult } from '../../src/mcp/toolkit.ts';
import {
  callWrite,
  connectMcpClient,
  createDemoKitchen,
  type DemoKitchen,
  internalCall,
  mcpTestConfig,
  startPasta,
  withAdmin,
} from '../../../../test/fixtures.ts';

describe('reject a card', () => {
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

  const proposed = async (name: string, args: Record<string, unknown>) =>
    (await callWrite(client, name, args)).structuredContent as { proposal_id: string; version: number };
  const reject = (id: string, version: number, requestId = randomUUID()) =>
    internalCall(servers, `/internal/proposals/${id}/reject`, { version, request_id: requestId });
  const confirm = (id: string, version: number) =>
    internalCall(servers, `/internal/proposals/${id}/confirm`, { version, user_id: 'demo', channel: 'ui_click', request_id: randomUUID() });
  const status = async (id: string) =>
    withAdmin(async (admin) => (await admin.query(`SELECT status FROM pantry.proposals WHERE id = $1`, [id])).rows[0].status);

  it('rejects an intake card: nothing is written and it can no longer be confirmed (B1)', async () => {
    const p = await proposed('propose_intake', { items: [{ name: 'egg', quantity: 12 }] });
    expect(await reject(p.proposal_id, 1)).toEqual({
      status: 200,
      body: { status: 'rejected', proposal_id: p.proposal_id, version: 1, kind: 'intake' },
    });
    expect(await status(p.proposal_id)).toBe('rejected');
    expect(await confirm(p.proposal_id, 1)).toMatchObject({ status: 409, body: { code: 'not_pending', status: 'rejected' } });
    const batches = await withAdmin(async (admin) =>
      admin.query(`SELECT 1 FROM pantry.batches WHERE household_id = $1`, [kitchen.householdId]),
    );
    expect(batches.rowCount).toBe(0);
  });

  it('hands a rejected consume card’s session back to cooking (§3.1)', async () => {
    const sessionId = await startPasta(kitchen, client);
    const p = await proposed('propose_consumption', {});
    expect((await reject(p.proposal_id, 1)).status).toBe(200);
    const session = await withAdmin(async (admin) =>
      (await admin.query(`SELECT state, state_version FROM pantry.cooking_sessions WHERE id = $1`, [sessionId])).rows[0],
    );
    expect(session).toEqual({ state: 'cooking', state_version: 3 });
    expect(parseErrorResult(await callWrite(client, 'next_step', { expected_step: 1 }))).toBeNull();
    const again = await proposed('propose_consumption', {});
    expect(again.proposal_id).not.toBe(p.proposal_id);
  });

  it('replays a retried reject and refuses a second one', async () => {
    const p = await proposed('propose_intake', { items: [{ name: 'egg', quantity: 6 }] });
    const requestId = randomUUID();
    const first = await reject(p.proposal_id, 1, requestId);
    expect(await reject(p.proposal_id, 1, requestId)).toEqual(first);
    expect(await reject(p.proposal_id, 1)).toMatchObject({ status: 409, body: { code: 'not_pending' } });
  });

  it('refuses an old version, a committed card and an expired one', async () => {
    const conversationId = randomUUID();
    const v1 = (await callWrite(client, 'propose_intake', { items: [{ name: 'egg', quantity: 6 }] }, { conversationId }))
      .structuredContent as { proposal_id: string };
    await callWrite(client, 'propose_intake', { items: [{ name: 'egg', quantity: 5 }] }, { conversationId });
    expect(await reject(v1.proposal_id, 1)).toMatchObject({ status: 409, body: { code: 'stale_proposal', current_version: 2 } });

    await confirm(v1.proposal_id, 2);
    expect(await reject(v1.proposal_id, 2)).toMatchObject({ status: 409, body: { code: 'already_committed' } });

    const old = await proposed('propose_intake', { items: [{ name: 'egg', quantity: 1 }] });
    await withAdmin((admin) => admin.query(`UPDATE pantry.proposals SET expires_at = now() - interval '1 second' WHERE id = $1`, [old.proposal_id]));
    expect(await reject(old.proposal_id, 1)).toMatchObject({ status: 409, body: { code: 'expired' } });
    expect(await status(old.proposal_id)).toBe('expired');
  });

  it('answers 404 for an unknown card and 400 for a malformed request', async () => {
    expect((await reject(randomUUID(), 1)).status).toBe(404);
    expect((await internalCall(servers, `/internal/proposals/${randomUUID()}/reject`, { version: 1 })).status).toBe(400);
    expect((await internalCall(servers, `/internal/proposals/not-a-uuid/reject`, { version: 1, request_id: randomUUID() })).status).toBe(400);
  });
});
