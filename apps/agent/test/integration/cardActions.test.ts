// Card buttons and the /api surface (§8.8, §11.4): proxied card actions, their app events, and the origin check.
import { randomUUID } from 'node:crypto';
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
import { agentRows, APP_ORIGIN, callTools, cardAction, chat, lastMessage, say, startAgent, type TestAgent } from '../fixtures.ts';

describe('card actions and the /api surface', () => {
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

  const events = () =>
    agentRows<{ kind: string; triggers_turn: boolean; payload: Record<string, unknown> }>(
      agent,
      `SELECT kind, triggers_turn, payload FROM agent.app_events WHERE conversation_id = $1 ORDER BY created_at`,
      [agent.conversationId],
    );
  const discardCard = async () => {
    await stockKitchen(kitchen, { egg: 12, tomato: 4, 'olive oil': 100, scallion: 2 });
    agent.model.push(callTools(['propose_adjustment', { item: 'egg', delta: -2, reason: 'discard' }]), say('OK.'));
    await chat(agent, 'I dropped two eggs');
    return (await lastMessage(agent)).voice_prompt as { proposal_id: string; version: number };
  };

  it('rejects a card by button and records it for the next turn', async () => {
    const card = await discardCard();
    const res = await cardAction(agent, 'POST', `/api/proposals/${card.proposal_id}/reject`, { version: 1 });
    expect(res.status).toBe(200);
    expect(await events()).toEqual([
      { kind: 'proposal_rejected', triggers_turn: false, payload: { proposal_id: card.proposal_id, version: 1, kind: 'adjust' } },
    ]);
    // The next user turn tells the model.
    agent.model.push(say('OK.'));
    await chat(agent, 'thanks');
    expect(agent.model.requests.at(-1)!.messages.at(-1)!.content).toEqual([
      { text: `[app event] proposal ${card.proposal_id} v1 (adjust) was discarded by the user.` },
      { text: 'thanks' },
    ]);
  });

  it('reports a stale card from a button confirm, then refreshes it and reads the new one back', async () => {
    const card = await discardCard();
    await eatMeal(servers, client, 'tomato egg stir-fry');
    const stale = await cardAction(agent, 'POST', `/api/proposals/${card.proposal_id}/confirm`, { version: 1 });
    expect(stale).toMatchObject({ status: 409, body: { code: 'stale_state', reason: 'batch_changed' } });
    expect(await events()).toEqual([expect.objectContaining({ kind: 'proposal_stale', triggers_turn: true })]);

    const fresh = await cardAction(agent, 'POST', `/api/proposals/${card.proposal_id}/regenerate`, {});
    expect(fresh.status).toBe(200);
    const readBack = await lastMessage(agent);
    expect(readBack).toMatchObject({
      turn_type: 'gate',
      voice_prompt: { kind: 'proposal_confirm', proposal_id: fresh.body.proposal_id, version: 1 },
      cards: [expect.objectContaining({ type: 'proposal', proposal_id: fresh.body.proposal_id })],
    });
    expect(readBack.speech).toMatch(/^I'll record that 2 eggs were thrown out\./);
  });

  it('replays a repeated click instead of acting twice', async () => {
    const card = await discardCard();
    const requestId = randomUUID();
    const first = await cardAction(agent, 'POST', `/api/proposals/${card.proposal_id}/confirm`, { version: 1, request_id: requestId });
    const again = await cardAction(agent, 'POST', `/api/proposals/${card.proposal_id}/confirm`, { version: 1, request_id: requestId });
    expect(first.status).toBe(200);
    expect(again).toEqual(first);
    expect(await events()).toHaveLength(1);
  });

  it("acts only on this household's conversations' cards", async () => {
    // A card made by another MCP client exists, but not in any of the agent's conversations.
    await stockKitchen(kitchen, { egg: 12 });
    const foreign = (await callWrite(client, 'propose_adjustment', { item: 'egg', delta: -1, reason: 'discard' })).structuredContent as {
      proposal_id: string;
    };
    expect((await cardAction(agent, 'POST', `/api/proposals/${foreign.proposal_id}/confirm`, { version: 1 })).status).toBe(404);
    expect((await cardAction(agent, 'POST', `/api/proposals/${randomUUID()}/reject`, { version: 1 })).status).toBe(404);
    expect((await cardAction(agent, 'POST', `/api/proposals/not-a-uuid/reject`, { version: 1 })).status).toBe(400);
  });

  it('refuses state-changing requests without the app origin (S8 origin half)', async () => {
    const payload = { conversation_id: agent.conversationId, request_id: randomUUID(), text: 'hi', input_mode: 'text' };
    expect((await agent.app.inject({ method: 'POST', url: '/api/chat', payload })).statusCode).toBe(403);
    expect(
      (await agent.app.inject({ method: 'POST', url: '/api/chat', headers: { origin: 'https://evil.example' }, payload })).statusCode,
    ).toBe(403);
    agent.model.push(say('Hi.'));
    expect((await agent.app.inject({ method: 'POST', url: '/api/chat', headers: { origin: APP_ORIGIN }, payload })).statusCode).toBe(200);
  });

  it('validates input and keeps conversations to their household and user', async () => {
    expect((await chat(agent, '')).status).toBe(400);
    const res = await agent.app.inject({ method: 'GET', url: `/api/messages?conversation_id=${randomUUID()}` });
    expect(res.statusCode).toBe(404);
    expect((await agent.app.inject({ method: 'GET', url: '/api/messages?conversation_id=nope' })).statusCode).toBe(400);

    // A conversation id another household already uses cannot be taken over.
    const other = await startAgent(servers, await createDemoKitchen());
    try {
      other.model.push(say('Hi.'));
      expect((await chat(other, 'hi', { conversationId: agent.conversationId })).status).toBe(200);
      expect((await chat(agent, 'hi')).status).toBe(404);
      const theirs = await agent.app.inject({ method: 'GET', url: `/api/messages?conversation_id=${agent.conversationId}` });
      expect(theirs.statusCode).toBe(404);
    } finally {
      await other.close();
    }
  });

  it('rate-limits chat per user (S6)', async () => {
    const limited = await startAgent(servers, kitchen, { config: { chatRatePerMinute: 2 } });
    try {
      limited.model.push(say('1'), say('2'));
      expect((await chat(limited, 'one')).status).toBe(200);
      expect((await chat(limited, 'two')).status).toBe(200);
      const third = await chat(limited, 'three');
      expect(third.status).toBe(429);
      expect(third.headers['retry-after']).toBeDefined();
    } finally {
      await limited.close();
    }
  });
});
