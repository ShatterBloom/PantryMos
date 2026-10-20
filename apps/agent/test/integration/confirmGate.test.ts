// ConfirmGate (§8.5, §9.5): VC1–VC14, with a scripted model whose call count proves the gate never used it.
import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type RunningServers, startServers } from '@pantrymos/mcp-server';
import {
  confirmCard,
  connectMcpClient,
  createDemoKitchen,
  type DemoKitchen,
  eatMeal,
  internalCall,
  mcpTestConfig,
  stockKitchen,
  withAdmin,
} from '../../../../test/fixtures.ts';
import {
  ack,
  agentRows,
  callTools,
  cardAction,
  chat,
  lastMessage,
  messages,
  type Outbound,
  say,
  startAgent,
  type TestAgent,
  voice,
} from '../fixtures.ts';

describe('ConfirmGate', () => {
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
    agent = await startAgent(servers, kitchen, { windowMs: 1000 });
    client = await connectMcpClient(servers, kitchen.token);
  });
  afterEach(async () => {
    await client.close();
    await agent.close();
  });

  const proposal = (m: Outbound) => m.voice_prompt as { proposal_id: string; version: number };
  const confirmations = async () =>
    withAdmin(async (admin) =>
      (
        await admin.query(
          `SELECT c.version, c.channel, c.utterance, c.outcome FROM pantry.confirmations c
             JOIN pantry.proposals p ON p.id = c.proposal_id
            WHERE p.household_id = $1 AND c.channel = 'voice_rule' ORDER BY c.confirmed_at`,
          [kitchen.householdId],
        )
      ).rows,
    );
  const proposalStatus = async (id: string) =>
    withAdmin(async (admin) => (await admin.query(`SELECT status FROM pantry.proposals WHERE id = $1`, [id])).rows[0].status);
  const timers = () => agentRows(agent, `SELECT label, seconds, status FROM agent.timers WHERE conversation_id = $1`, [agent.conversationId]);
  const events = () =>
    agentRows<{ kind: string; triggers_turn: boolean }>(
      agent,
      `SELECT kind, triggers_turn FROM agent.app_events WHERE conversation_id = $1 ORDER BY created_at`,
      [agent.conversationId],
    );

  /** A user turn that proposes adding eggs; the card is read back (not yet acked). */
  const intakeCard = async (quantity = 6) => {
    agent.model.push(callTools(['propose_intake', { items: [{ name: 'egg', quantity }] }]), say('OK.'));
    expect((await chat(agent, `I bought ${quantity} eggs`)).status).toBe(200);
    return lastMessage(agent);
  };
  /** Cooks the stir-fry to step 2, whose timer the app offers (not yet acked). */
  const timerOffer = async () => {
    await stockKitchen(kitchen, { egg: 6, tomato: 4, 'olive oil': 100, scallion: 2 });
    agent.model.push(callTools(['start_cooking', { recipe_name: 'tomato egg stir-fry' }]), say('Step 1.'));
    await chat(agent, 'cook the stir-fry');
    agent.model.push(callTools(['next_step']), say('Step 2.'));
    await chat(agent, 'next');
    const offer = await lastMessage(agent);
    expect(offer.voice_prompt).toMatchObject({ kind: 'timer_offer', seconds: 60 });
    return offer;
  };
  const modelCalls = () => agent.model.requests.length;

  it('VC1: "yes" in the window confirms the version read back, with no model call', async () => {
    const card = await intakeCard();
    expect((await ack(agent, card.id)).status).toBe(200);
    const calls = modelCalls();
    expect(await voice(agent, 'Mos, yes!')).toMatchObject({ status: 200 });
    expect(modelCalls()).toBe(calls);
    expect(await confirmations()).toEqual([{ version: 1, channel: 'voice_rule', utterance: 'yes', outcome: 'committed' }]);
    expect(await lastMessage(agent)).toMatchObject({ turn_type: 'gate', speech: 'Done — added to your stock.', voice_prompt: null });
    expect(await events()).toEqual([{ kind: 'proposal_committed', triggers_turn: false }]);
  });

  it('VC2: after an edit to v2, "confirm" before v2 is acked re-reads v2 instead of committing v1', async () => {
    const v1 = await intakeCard();
    await ack(agent, v1.id);
    const edited = await cardAction(agent, 'PATCH', `/api/proposals/${proposal(v1).proposal_id}`, {
      base_version: 1,
      changes: { items: [{ name: 'egg', quantity: 12 }] },
    });
    expect(edited.status).toBe(200);
    const v2 = await lastMessage(agent);
    expect(v2).toMatchObject({ turn_type: 'gate', voice_prompt: { kind: 'proposal_confirm', version: 2 } });
    expect(v2.speech).toMatch(/^I'll add 12 eggs\./);

    const calls = modelCalls();
    await voice(agent, 'confirm');
    expect(modelCalls()).toBe(calls);
    expect(await confirmations()).toEqual([]);
    expect(await lastMessage(agent)).toMatchObject({ speech: v2.speech, voice_prompt: { version: 2 } });
    expect((await events()).map((e) => e.kind)).toEqual(['window_expired']);

    // Once v2 is acked, "confirm" commits v2.
    await ack(agent, (await lastMessage(agent)).id);
    await voice(agent, 'confirm');
    expect(await confirmations()).toEqual([expect.objectContaining({ version: 2, outcome: 'committed' })]);
  });

  it('VC3: "yes but three eggs", "no wait" and "no" go to the model and commit nothing', async () => {
    const card = await intakeCard();
    for (const utterance of ['yes but three eggs', 'no wait', 'no']) {
      await ack(agent, (await lastMessage(agent)).id);
      agent.model.push(say('What should I change?'));
      expect((await voice(agent, utterance)).status).toBe(200);
      expect(await lastMessage(agent)).toMatchObject({ turn_type: 'user', speech: 'What should I change?' });
    }
    expect(agent.model.remaining).toBe(0);
    expect(await confirmations()).toEqual([]);
    expect(await proposalStatus(proposal(card).proposal_id)).toBe('pending');
  });

  it('VC4: "yes" after the window ran out re-reads the card and commits nothing', async () => {
    const card = await intakeCard();
    await ack(agent, card.id);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const calls = modelCalls();
    await voice(agent, 'yes');
    expect(modelCalls()).toBe(calls);
    expect(await confirmations()).toEqual([]);
    expect(await lastMessage(agent)).toMatchObject({ turn_type: 'gate', speech: card.speech.replace(/^OK\. /, ''), voice_prompt: { version: 1 } });
    expect((await events()).map((e) => e.kind)).toEqual(['window_expired']);
  });

  it('VC5: "yes" with no card at all is a normal model turn', async () => {
    agent.model.push(say('Yes to what?'));
    await voice(agent, 'yes');
    expect(await lastMessage(agent)).toMatchObject({ turn_type: 'user', speech: 'Yes to what?' });
    expect(await confirmations()).toEqual([]);
  });

  it('VC6: "cancel" in the window discards the card', async () => {
    const card = await intakeCard();
    await ack(agent, card.id);
    await voice(agent, 'Cancel.');
    expect(await lastMessage(agent)).toMatchObject({ turn_type: 'gate', speech: 'OK, I discarded that card.' });
    expect(await proposalStatus(proposal(card).proposal_id)).toBe('rejected');
    expect(await events()).toEqual([{ kind: 'proposal_rejected', triggers_turn: false }]);
  });

  it('VC7: a card that went stale is refreshed and read back with a new window, with no model call', async () => {
    await stockKitchen(kitchen, { egg: 12, tomato: 4, 'olive oil': 100, scallion: 2 });
    agent.model.push(callTools(['propose_adjustment', { item: 'egg', delta: -2, reason: 'discard' }]), say('OK.'));
    await chat(agent, 'I dropped two eggs');
    const card = await lastMessage(agent);
    await ack(agent, card.id);
    // Another app records a meal from the same batch meanwhile.
    await eatMeal(servers, client, 'tomato egg stir-fry');

    const calls = modelCalls();
    await voice(agent, 'yes');
    expect(modelCalls()).toBe(calls);
    const reread = await lastMessage(agent);
    expect(reread.speech).toMatch(/^That card changed\. Here's the updated one: I'll record that 2 eggs were thrown out\./);
    expect(reread.voice_prompt).toMatchObject({ kind: 'proposal_confirm', version: 1 });
    expect(proposal(reread).proposal_id).not.toBe(proposal(card).proposal_id);
    expect(await confirmations()).toEqual([expect.objectContaining({ outcome: 'stale' })]);
    expect(await events()).toEqual([{ kind: 'proposal_stale', triggers_turn: false }]);

    await ack(agent, reread.id);
    await voice(agent, 'yes');
    expect(await lastMessage(agent)).toMatchObject({ speech: 'Done — the stock is updated.' });
  });

  it('VC8: the same "yes" sent twice, also concurrently, confirms once', async () => {
    const card = await intakeCard();
    await ack(agent, card.id);
    const requestId = randomUUID();
    const [a, b] = await Promise.all([voice(agent, 'yes', requestId), voice(agent, 'yes', requestId)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(200);
    if (statuses[1] === 409) expect([a, b].find((r) => r.status === 409)!.body).toMatchObject({ code: 'request_in_progress' });
    else expect(a.body).toEqual(b.body);
    const again = await voice(agent, 'yes', requestId);
    expect(again.body).toEqual([a, b].find((r) => r.status === 200)!.body);

    expect(await confirmations()).toEqual([expect.objectContaining({ outcome: 'committed' })]);
    expect((await events()).filter((e) => e.kind === 'proposal_committed')).toHaveLength(1);
    expect((await messages(agent)).filter((m) => m.turn_type === 'gate')).toHaveLength(1);
  });

  it('VC9: "sure" to a timer offer starts the timer from the stored spec, with no model call', async () => {
    const offer = await timerOffer();
    await ack(agent, offer.id);
    const calls = modelCalls();
    await voice(agent, 'sure');
    expect(modelCalls()).toBe(calls);
    expect(await lastMessage(agent)).toMatchObject({ turn_type: 'gate', speech: 'Timer started: 1 minute.' });
    expect(await timers()).toEqual([{ label: 'eggs', seconds: 60, status: 'running' }]);
  });

  it('VC10: "no" or "not yet" declines the timer', async () => {
    for (const phrase of ['no', 'not yet']) {
      const offer = await timerOffer();
      await ack(agent, offer.id);
      await voice(agent, phrase);
      expect(await lastMessage(agent)).toMatchObject({ speech: "OK — say 'Mos, start the timer' when you're ready." });
      expect(await timers()).toEqual([]);
      await withAdmin((admin) => admin.query(`UPDATE pantry.cooking_sessions SET state = 'cancelled' WHERE household_id = $1`, [kitchen.householdId]));
    }
  });

  it('VC11: a card read back after a timer offer closes the offer; "yes" confirms the card', async () => {
    const offer = await timerOffer();
    await ack(agent, offer.id);
    const card = await intakeCard();
    await ack(agent, card.id);
    await voice(agent, 'yes');
    expect(await lastMessage(agent)).toMatchObject({ speech: 'Done — added to your stock.' });
    expect(await timers()).toEqual([]);
    const windows = await agentRows(agent, `SELECT kind, status FROM agent.voice_windows WHERE conversation_id = $1 ORDER BY created_at`, [
      agent.conversationId,
    ]);
    expect(windows).toEqual([
      { kind: 'timer_offer', status: 'closed' },
      { kind: 'proposal_confirm', status: 'consumed' },
    ]);
  });

  it('VC12: an ack for a message without a prompt, or for another conversation, opens nothing', async () => {
    agent.model.push(say('Hello.'));
    await chat(agent, 'hi');
    const plain = await lastMessage(agent);
    expect((await ack(agent, plain.id)).status).toBe(404);

    const card = await intakeCard();
    const other = randomUUID();
    agent.model.push(say('Hi.'));
    await chat(agent, 'hi', { conversationId: other });
    expect((await ack(agent, card.id, other)).status).toBe(404);
    expect((await ack(agent, card.id, randomUUID())).status).toBe(404);
    expect(await agentRows(agent, `SELECT 1 FROM agent.voice_windows WHERE conversation_id = $1`, [agent.conversationId])).toEqual([]);
  });

  it('VC13: a repeated ack returns the same window without extending it', async () => {
    const card = await intakeCard();
    const first = await ack(agent, card.id);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const second = await ack(agent, card.id);
    expect(second).toEqual(first);
    expect(await agentRows(agent, `SELECT 1 FROM agent.voice_windows WHERE conversation_id = $1`, [agent.conversationId])).toHaveLength(1);
  });

  it('VC14: a retried "sure" starts exactly one timer', async () => {
    const offer = await timerOffer();
    await ack(agent, offer.id);
    const requestId = randomUUID();
    await voice(agent, 'sure', requestId);
    await voice(agent, 'sure', requestId);
    expect(await timers()).toHaveLength(1);
  });

  describe('when the card moved on under the window', () => {
    it('reads back the newer version another device made (stale_proposal)', async () => {
      const card = await intakeCard();
      await ack(agent, card.id);
      const edit = await internalCall(
        servers,
        `/internal/proposals/${proposal(card).proposal_id}`,
        { base_version: 1, changes: { items: [{ name: 'egg', quantity: 10 }] }, request_id: randomUUID() },
        'PATCH',
      );
      expect(edit.status).toBe(200);
      await voice(agent, 'yes');
      const reread = await lastMessage(agent);
      expect(reread.speech).toMatch(/^That card changed\. Here's the updated one: I'll add 10 eggs\./);
      expect(reread.voice_prompt).toMatchObject({ proposal_id: proposal(card).proposal_id, version: 2 });
      expect(await confirmations()).toEqual([]);
    });

    it('says so when the card was already saved elsewhere, or expired', async () => {
      const saved = await intakeCard();
      await ack(agent, saved.id);
      expect((await confirmCard(servers, proposal(saved), 1)).status).toBe(200);
      await voice(agent, 'yes');
      expect((await lastMessage(agent)).speech).toBe('That card was already saved.');

      const expired = await intakeCard(3);
      await ack(agent, expired.id);
      await withAdmin((admin) =>
        admin.query(`UPDATE pantry.proposals SET expires_at = now() - interval '1 second' WHERE id = $1`, [proposal(expired).proposal_id]),
      );
      await voice(agent, 'yes');
      expect((await lastMessage(agent)).speech).toBe('That card expired. Please ask again.');
    });

    it("speaks the refresh's own error when a stale card can no longer be made", async () => {
      await stockKitchen(kitchen, { egg: 4, tomato: 4, 'olive oil': 100, scallion: 2 });
      agent.model.push(callTools(['propose_adjustment', { item: 'egg', delta: -2, reason: 'discard' }]), say('OK.'));
      await chat(agent, 'I dropped two eggs');
      const card = await lastMessage(agent);
      await ack(agent, card.id);
      await eatMeal(servers, client, 'tomato egg stir-fry'); // 3 of the 4 eggs: 1 left
      await voice(agent, 'yes');
      expect((await lastMessage(agent)).speech).toBe('Only 1 egg is recorded, not 2.');
      expect((await lastMessage(agent)).voice_prompt).toBeNull();
    });
  });

  it('only answers the latest question: an ack for an older prompt is refused', async () => {
    const first = await intakeCard(6);
    await intakeCard(12);
    expect((await ack(agent, first.id)).status).toBe(409);
  });
});
