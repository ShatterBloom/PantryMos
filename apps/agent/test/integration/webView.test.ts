// The web view's reads (§8.8): inventory and ledger proxied for the agent's household, timers, and a card's state.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type RunningServers, startServers } from '@pantrymos/mcp-server';
import {
  callWrite,
  connectMcpClient,
  createDemoKitchen,
  type DemoKitchen,
  eatMeal,
  mcpTestConfig,
  stockKitchen,
} from '../../../../test/fixtures.ts';
import { callTools, cardAction, chat, lastMessage, say, startAgent, type TestAgent } from '../fixtures.ts';

describe('web view reads', () => {
  let servers: RunningServers;
  beforeAll(async () => {
    servers = await startServers(mcpTestConfig(), { log: false });
  });
  afterAll(async () => servers.close());

  let kitchen: DemoKitchen;
  let agent: TestAgent;
  let client: Client;
  beforeEach(async () => {
    kitchen = await createDemoKitchen();
    agent = await startAgent(servers, kitchen);
    client = await connectMcpClient(servers, kitchen.token);
  });
  afterEach(async () => {
    await client.close();
    await agent.close();
  });

  const get = async (url: string) => {
    const res = await agent.api({ method: 'GET', url });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  };

  it('serves the built web app from the same origin, without a session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pantrymos-web-'));
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>PantryMos</title>');
    const served = await startAgent(servers, kitchen, { config: { webDir: dir } });
    try {
      const page = await served.app.inject({ method: 'GET', url: '/' });
      expect(page.statusCode).toBe(200);
      expect(page.headers['content-type']).toMatch(/^text\/html/);
      expect(page.body).toContain('<title>PantryMos</title>');
      expect((await served.app.inject({ method: 'GET', url: '/../package.json' })).statusCode).toBe(404);
      expect((await served.app.inject({ method: 'GET', url: '/api/inventory' })).statusCode).toBe(401);
    } finally {
      await served.close();
      await rm(dir, { recursive: true, force: true });
    }
    expect((await agent.app.inject({ method: 'GET', url: '/' })).statusCode).toBe(404); // not configured
  });

  it("serves the household's inventory and ledger", async () => {
    await stockKitchen(kitchen, { egg: 12, tomato: 4, 'olive oil': 100, scallion: 2 });
    await eatMeal(servers, client, 'tomato egg stir-fry');

    const inventory = await get('/api/inventory');
    expect(inventory.status).toBe(200);
    expect(inventory.body.items).toContainEqual(expect.objectContaining({ item: 'egg', unit: 'count' }));
    expect(inventory.body.shopping_list).toEqual([]);

    const ledger = await get('/api/ledger?limit=1');
    expect(ledger.status).toBe(200);
    expect(ledger.body.operations).toEqual([expect.objectContaining({ kind: 'consume', confirmed: expect.objectContaining({ channel: 'ui_click' }) })]);
    expect((await get('/api/ledger?limit=0')).status).toBe(400);
  });

  it('lists running timers, and reads a card as it stands now', async () => {
    agent.model.push(callTools(['start_timer', { label: 'pasta', seconds: 600 }]), say('Started.'));
    await chat(agent, 'set a pasta timer');
    const timers = await get(`/api/timers?conversation_id=${agent.conversationId}`);
    expect(timers).toEqual({
      status: 200,
      body: { timers: [expect.objectContaining({ label: 'pasta', status: 'running', remaining_seconds: expect.any(Number) })] },
    });
    expect((await get(`/api/timers?conversation_id=${randomUUID()}`)).status).toBe(404);
    expect((await get('/api/timers')).status).toBe(400);

    await stockKitchen(kitchen, { egg: 12 });
    agent.model.push(callTools(['propose_adjustment', { item: 'egg', delta: -2, reason: 'discard' }]), say('OK.'));
    await chat(agent, 'I dropped two eggs');
    const card = (await lastMessage(agent)).voice_prompt as { proposal_id: string };
    expect(await get(`/api/proposals/${card.proposal_id}`)).toMatchObject({ status: 200, body: { status: 'pending', version: 1 } });
    await cardAction(agent, 'POST', `/api/proposals/${card.proposal_id}/confirm`, { version: 1 });
    expect(await get(`/api/proposals/${card.proposal_id}`)).toMatchObject({ status: 200, body: { status: 'committed' } });

    // Another client's card is not in any of the agent's conversations.
    const foreign = (await callWrite(client, 'propose_adjustment', { item: 'egg', delta: -1, reason: 'discard' })).structuredContent as {
      proposal_id: string;
    };
    expect((await get(`/api/proposals/${foreign.proposal_id}`)).status).toBe(404);
    expect((await get('/api/proposals/nope')).status).toBe(400);
  });
});
