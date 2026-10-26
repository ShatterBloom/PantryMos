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
  stockKitchen,
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
        household_id: kitchen.householdId,
        conversation_id: conversationId,
        card: p.card,
        editable: { type: 'items', items: [{ name: 'egg', quantity: 6 }], lines: [{ item: 'egg', quantity: 6, unit: 'count' }] },
        expires_at: p.expires_at,
      },
    });
    expect((await confirmCard(servers, p, 1)).status).toBe(200);
    expect((await view(p.proposal_id)).body.status).toBe('committed');
  });

  it('says what each kind of card can edit, in the shape an edit takes back', async () => {
    await stockKitchen(kitchen, { egg: 12, tomato: 4, 'olive oil': 100, scallion: 2 });
    const edit = (id: string, base_version: number, changes: unknown) =>
      internalCall(servers, `/internal/proposals/${id}`, { base_version, changes, request_id: randomUUID() }, 'PATCH');
    const propose = async (tool: string, args: Record<string, unknown>) =>
      (await callWrite(client, tool, args)).structuredContent as { proposal_id: string; version: number };

    // Intake: the stored items, with the lines as shown.
    const intake = await propose('propose_intake', { items: [{ name: 'milk', quantity: 2, unit: 'l' }, { name: 'egg', quantity: 6 }] });
    const intakeView = (await view(intake.proposal_id)).body.editable as { items: Array<Record<string, unknown>> };
    expect(intakeView).toEqual({
      type: 'items',
      items: [{ name: 'milk', quantity: 2, unit: 'l' }, { name: 'egg', quantity: 6 }],
      lines: [{ item: 'milk', quantity: 2, unit: 'l' }, { item: 'egg', quantity: 6, unit: 'count' }],
    });
    expect((await edit(intake.proposal_id, 1, { items: [{ ...intakeView.items[0], quantity: 1 }] })).status).toBe(200);
    expect((await view(intake.proposal_id)).body.editable).toMatchObject({ lines: [{ item: 'milk', quantity: 1, unit: 'l' }] });

    // Adjust: the amount, delta or counted.
    const adjust = await propose('propose_adjustment', { item: 'egg', delta: -2, reason: 'discard' });
    expect((await view(adjust.proposal_id)).body.editable).toEqual({ type: 'amount', field: 'delta', item: 'egg', value: -2, unit: 'count' });
    expect((await edit(adjust.proposal_id, 1, { delta: -3 })).status).toBe(200);
    expect((await view(adjust.proposal_id)).body.editable).toMatchObject({ value: -3 });
    const counted = await propose('propose_adjustment', { item: 'tomato', set_quantity: 3, reason: 'stock_check' });
    expect((await view(counted.proposal_id)).body.editable).toEqual({ type: 'amount', field: 'set_quantity', item: 'tomato', value: 3, unit: 'count' });

    // Consume, then revise: the planned lines, edited one at a time.
    await callWrite(client, 'start_cooking', { recipe_name: 'tomato egg stir-fry' });
    const consume = await propose('propose_consumption', {});
    const consumeLines = ((await view(consume.proposal_id)).body.editable as { field: string; lines: Array<{ item: string }> });
    expect(consumeLines).toMatchObject({ type: 'lines', field: 'overrides' });
    expect(consumeLines.lines).toContainEqual({ item: 'egg', quantity: expect.any(Number), unit: 'count' });
    expect((await edit(consume.proposal_id, 1, { overrides: [{ item: 'egg', quantity: 1 }] })).status).toBe(200);
    expect((await view(consume.proposal_id)).body.editable).toMatchObject({ lines: expect.arrayContaining([{ item: 'egg', quantity: 1, unit: 'count' }]) });
    expect((await confirmCard(servers, consume, 2)).status).toBe(200);

    const revise = await propose('propose_consumption_revision', { usage: [{ item: 'egg', quantity: 2 }] });
    expect((await view(revise.proposal_id)).body.editable).toMatchObject({
      type: 'lines',
      field: 'usage',
      lines: expect.arrayContaining([{ item: 'egg', quantity: 2, unit: 'count' }]),
    });

    // Undo: nothing to edit.
    const undo = await propose('propose_undo', { target: 'last' });
    expect((await view(undo.proposal_id)).body.editable).toBeNull();
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
