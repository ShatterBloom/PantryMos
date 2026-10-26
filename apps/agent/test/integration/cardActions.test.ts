// Card buttons and the /api surface (§8.8): proxied card actions and their app events.
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
import { agentRows, callTools, cardAction, chat, lastMessage, lastToolResults, say, startAgent, type TestAgent } from '../fixtures.ts';

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

  it('makes one card per turn, so "confirm" answers the only card read back', async () => {
    await stockKitchen(kitchen, { egg: 12, tomato: 4 });
    agent.model.push(
      callTools(['propose_adjustment', { item: 'egg', delta: -2, reason: 'discard' }], ['propose_adjustment', { item: 'tomato', delta: -1, reason: 'discard' }]),
      say('OK.'),
    );
    await chat(agent, 'I dropped two eggs and a tomato');

    expect(lastToolResults(agent.model.requests.at(-1)!)).toEqual([
      expect.objectContaining({ proposal_id: expect.any(String) }),
      expect.objectContaining({ code: 'one_card_per_turn' }),
    ]);
    const message = await lastMessage(agent);
    const [card] = message.cards as Array<{ type: string; proposal_id: string }>;
    expect(message.cards).toHaveLength(1);
    expect(message.voice_prompt).toEqual({ kind: 'proposal_confirm', proposal_id: card!.proposal_id, version: 1 });
    expect(message.speech).toMatch(/^OK\. I'll record that 2 eggs were thrown out\./);
    expect(message.speech).not.toMatch(/tomato/);
  });

  it('reads a card back once, though the model repeated the read-back', async () => {
    await stockKitchen(kitchen, { egg: 12 });
    agent.model.push(callTools(['propose_adjustment', { item: 'egg', delta: -2, reason: 'discard' }]), (req) => {
      const { card } = lastToolResults(req)[0] as { card: { readback_text: string } };
      return say(`Got it. ${card.readback_text}`);
    });
    await chat(agent, 'I dropped two eggs');
    const { speech } = await lastMessage(agent);
    expect(speech).toMatch(/^Got it\. I'll record that 2 eggs were thrown out\./);
    expect(speech.match(/Say confirm/g)).toHaveLength(1);
  });

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

  it('reads back the card an edit made when the edit lands on other batches', async () => {
    // Two egg batches: 8 eggs span both (subject adjust:item), 2 come from the oldest alone.
    await stockKitchen(kitchen, { egg: 4 }, 10);
    await stockKitchen(kitchen, { egg: 12 }, 1);
    agent.model.push(callTools(['propose_adjustment', { item: 'egg', share: { fraction: 0.5, of: 'stock' }, reason: 'discard' }]), say('OK.'));
    await chat(agent, 'I dropped half the eggs');
    const card = (await lastMessage(agent)).voice_prompt as { proposal_id: string };

    const res = await cardAction(agent, 'PATCH', `/api/proposals/${card.proposal_id}`, { base_version: 1, changes: { delta: -2 } });
    expect(res).toMatchObject({ status: 200, body: { superseded: card.proposal_id } });
    const readBack = await lastMessage(agent);
    expect(readBack).toMatchObject({
      turn_type: 'gate',
      speech: "I'll record that 2 eggs were thrown out. Say confirm, or tell me what to change.",
      voice_prompt: { kind: 'proposal_confirm', proposal_id: res.body.proposal_id, version: 1 },
    });
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

  it("acts only on this household's cards, and on another client's card only in an open chat", async () => {
    // A card made by another MCP client exists, but not in any of the agent's conversations.
    await stockKitchen(kitchen, { egg: 12 });
    const foreign = (await callWrite(client, 'propose_adjustment', { item: 'egg', delta: -1, reason: 'discard' })).structuredContent as {
      proposal_id: string;
    };
    expect((await cardAction(agent, 'POST', `/api/proposals/${foreign.proposal_id}/confirm`, { version: 1 })).status).toBe(404);
    expect((await cardAction(agent, 'POST', `/api/proposals/${randomUUID()}/reject`, { version: 1 })).status).toBe(404);
    expect((await cardAction(agent, 'POST', `/api/proposals/not-a-uuid/reject`, { version: 1 })).status).toBe(400);

    // Another household's card, even with a chat to answer it in.
    const other = await createDemoKitchen();
    await stockKitchen(other, { egg: 12 });
    const otherClient = await connectMcpClient(servers, other.token);
    try {
      const theirs = (await otherClient.callTool({ name: 'propose_adjustment', arguments: { item: 'egg', delta: -1, reason: 'discard' } }))
        .structuredContent as { proposal_id: string };
      const res = await cardAction(agent, 'POST', `/api/proposals/${theirs.proposal_id}/confirm`, { version: 1, conversation_id: agent.conversationId });
      expect(res.status).toBe(404);
      expect((await agent.api({ method: 'GET', url: `/api/proposals/${theirs.proposal_id}` })).statusCode).toBe(404);
    } finally {
      await otherClient.close();
    }
  });

  it("lists another client's cards in the inbox, and answers one in the open chat without a model turn", async () => {
    await stockKitchen(kitchen, { egg: 12 });
    const inbox = async () => (await agent.api({ method: 'GET', url: '/api/inbox' })).json().proposals as Array<Record<string, unknown>>;
    // The app's own card stays in its chat, not the inbox.
    await discardCard();
    // A client that sends no _meta, such as a desktop assistant.
    const external = (await client.callTool({ name: 'propose_intake', arguments: { items: [{ name: 'milk', quantity: 1, unit: 'l' }] } }))
      .structuredContent as { proposal_id: string };
    expect(await inbox()).toEqual([
      {
        proposal_id: external.proposal_id,
        kind: 'intake',
        status: 'pending',
        version: 1,
        card: expect.objectContaining({ readback_text: expect.any(String) }),
        editable: expect.any(Object),
        expires_at: expect.any(String),
        client: 'test',
      },
    ]);
    const modelCalls = agent.model.requests.length;

    // A chat that has said nothing yet still answers it.
    const fresh = randomUUID();
    const res = await cardAction(agent, 'POST', `/api/proposals/${external.proposal_id}/confirm`, { version: 1, conversation_id: fresh });
    expect(res.status).toBe(200);
    expect(await inbox()).toEqual([]);
    const messages = (await agent.api({ method: 'GET', url: `/api/messages?conversation_id=${fresh}` })).json().messages as Array<{
      speech: string;
      turn_type: string;
    }>;
    expect(messages.map((m) => [m.turn_type, m.speech])).toEqual([['gate', 'Done — added to your stock.']]);
    const recorded = await agentRows<{ kind: string; triggers_turn: boolean }>(
      agent,
      `SELECT kind, triggers_turn FROM agent.app_events WHERE conversation_id = $1`,
      [fresh],
    );
    expect(recorded).toEqual([{ kind: 'proposal_committed', triggers_turn: false }]);
    expect(agent.model.requests).toHaveLength(modelCalls);
  });

  it('validates input and keeps conversations to their household and user', async () => {
    expect((await chat(agent, '')).status).toBe(400);
    const res = await agent.api({ method: 'GET', url: `/api/messages?conversation_id=${randomUUID()}` });
    expect(res.statusCode).toBe(404);
    expect((await agent.api({ method: 'GET', url: '/api/messages?conversation_id=nope' })).statusCode).toBe(400);

    // A conversation id another household already uses cannot be taken over.
    const other = await startAgent(servers, await createDemoKitchen());
    try {
      other.model.push(say('Hi.'));
      expect((await chat(other, 'hi', { conversationId: agent.conversationId })).status).toBe(200);
      expect((await chat(agent, 'hi')).status).toBe(404);
      const theirs = await agent.api({ method: 'GET', url: `/api/messages?conversation_id=${agent.conversationId}` });
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
