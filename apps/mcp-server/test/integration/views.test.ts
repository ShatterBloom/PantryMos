// GET /internal/views/inventory and /ledger: the web view's read models (§4.4, §8.8).
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
  eatMeal,
  internalCall,
  mcpTestConfig,
  stockKitchen,
} from '../../../../test/fixtures.ts';

describe('internal views', () => {
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

  const view = (path: string, householdId = kitchen.householdId) =>
    internalCall(servers, path, undefined, 'GET', { 'x-household-id': householdId });

  it('lists stock by item, in FEFO order, and the open shopping list', async () => {
    await stockKitchen(kitchen, { egg: 6 }, 3);
    await stockKitchen(kitchen, { egg: 4, tomato: 2 }, 1);
    await callWrite(client, 'add_to_shopping_list', { items: [{ name: 'milk', quantity: 1, unit: 'l' }, { name: 'star anise' }] });

    const res = await view('/internal/views/inventory');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      items: [
        {
          item: 'egg',
          total: 10,
          unit: 'count',
          batches: [
            expect.objectContaining({ quantity: 6, priority_source: 'estimate' }),
            expect.objectContaining({ quantity: 4, priority_source: 'estimate' }),
          ],
        },
        { item: 'tomato', total: 2, unit: 'count', batches: [expect.objectContaining({ quantity: 2 })] },
      ],
      shopping_list: [
        { id: expect.any(String), item: 'milk', quantity: 1, unit: 'l', source: 'manual' },
        { id: expect.any(String), item: 'star anise', quantity: null, unit: null, source: 'manual' },
      ],
    });
  });

  it('shows each operation with its confirmed version, how it was confirmed, and what reverted it', async () => {
    await stockKitchen(kitchen, { egg: 12, tomato: 4, 'olive oil': 100, scallion: 2 });
    const meal = await eatMeal(servers, client, 'tomato egg stir-fry');
    const undo = (await callWrite(client, 'propose_undo', { target: 'last' })).structuredContent as { proposal_id: string; version: number };
    const undone = await internalCall(servers, `/internal/proposals/${undo.proposal_id}/confirm`, {
      version: undo.version,
      user_id: 'demo',
      channel: 'voice_rule',
      utterance: 'confirm',
      request_id: randomUUID(),
    });
    expect(undone.status).toBe(200);

    const res = await view('/internal/views/ledger');
    expect(res.status).toBe(200);
    const [undoOp, mealOp] = res.body.operations as Array<Record<string, unknown>>;
    expect(undoOp).toMatchObject({
      operation_id: undone.body.operation_id,
      kind: 'undo',
      proposal_id: undo.proposal_id,
      proposal_version: 1,
      confirmed: { channel: 'voice_rule', utterance: 'confirm', user_id: 'demo' },
      reverted_by: null,
      reverts_operation_ids: [meal.operationId],
    });
    expect(undoOp!.summary).toMatch(/^Undo: \+/);
    expect(mealOp).toMatchObject({
      operation_id: meal.operationId,
      kind: 'consume',
      summary: expect.stringMatching(/^Cooked tomato egg stir-fry: −/),
      confirmed: { channel: 'ui_click', utterance: null, user_id: 'demo' },
      reverted_by: undone.body.operation_id,
      reverts_operation_ids: [],
    });
    expect(mealOp!.changes).toContainEqual({ item: 'egg', delta: expect.any(Number), unit: 'count' });

    const limited = await view('/internal/views/ledger?limit=1');
    expect((limited.body.operations as unknown[]).map((o) => (o as { kind: string }).kind)).toEqual(['undo']);
  });

  it('shows a confirmed re-proposal as its later version', async () => {
    await stockKitchen(kitchen, { egg: 12 });
    const first = (await callWrite(client, 'propose_adjustment', { item: 'egg', delta: -1, reason: 'discard' })).structuredContent as {
      proposal_id: string;
    };
    const second = (await callWrite(client, 'propose_adjustment', { item: 'egg', delta: -2, reason: 'discard' })).structuredContent as {
      proposal_id: string;
      version: number;
    };
    expect(second).toMatchObject({ proposal_id: first.proposal_id, version: 2 });
    expect((await confirmCard(servers, second, 2)).status).toBe(200);
    const res = await view('/internal/views/ledger');
    const [adjusted, stocked] = res.body.operations as Array<Record<string, unknown>>;
    expect(adjusted).toMatchObject({ kind: 'adjust', proposal_version: 2, changes: [{ item: 'egg', delta: -2, unit: 'count' }] });
    expect(stocked).toMatchObject({ kind: 'intake', summary: 'Groceries added: +12 eggs' });
  });

  it('needs a known household and valid parameters', async () => {
    expect((await view('/internal/views/inventory', randomUUID())).status).toBe(404);
    expect((await view('/internal/views/ledger', 'nope')).status).toBe(400);
    expect((await internalCall(servers, '/internal/views/inventory', undefined, 'GET')).status).toBe(400);
    expect((await view('/internal/views/ledger?limit=0')).status).toBe(400);
    expect((await view('/internal/views/ledger?limit=101')).status).toBe(400);
  });
});
