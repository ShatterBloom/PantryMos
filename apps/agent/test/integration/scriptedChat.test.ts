// M4 exit: a scripted chat completes intake → cook → consume, confirmations by voice through the gate.
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type RunningServers, startServers } from '@pantrymos/mcp-server';
import {
  callWrite,
  connectMcpClient,
  createDemoKitchen,
  type DemoKitchen,
  mcpTestConfig,
  stockKitchen,
  withAdmin,
} from '../../../../test/fixtures.ts';
import { EMPTY_REPLY_NUDGE, EMPTY_REPLY_RETRIES } from '../../src/turn/runTurn.ts';
import { TURN_FAILED } from '../../src/turn/speech.ts';
import { ack, agentRows, callTools, chat, lastMessage, lastToolResults, say, startAgent, type TestAgent, voice } from '../fixtures.ts';

describe('a scripted chat: intake → cook → consume', () => {
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

  const eggs = async () =>
    withAdmin(async (admin) =>
      Number(
        (await admin.query(`SELECT COALESCE(sum(quantity), 0) AS n FROM pantry.batches WHERE item_id = $1`, [kitchen.items.egg])).rows[0].n,
      ),
    );

  /** A session started on another device: this conversation never delivered a step. */
  const callWriteStart = async () => {
    const res = await callWrite(client, 'start_cooking', { recipe_name: 'tomato egg stir-fry' });
    expect(res.isError).toBeFalsy();
  };

  /** Speaks the message, acks it, and says `phrase`: the web app's hands-free loop. */
  const answer = async (phrase: string) => {
    const message = await lastMessage(agent);
    expect((await ack(agent, message.id)).status).toBe(200);
    return voice(agent, phrase);
  };

  it('asks again after a reply with nothing in it, and never delivers silence', async () => {
    const silent = { stopReason: 'end_turn', content: [] };
    agent.model.push(silent, say('Hi, what are we cooking?'));
    await chat(agent, 'hello');
    expect((await lastMessage(agent)).speech).toBe('Hi, what are we cooking?');
    // The retry carries the nudge; the history the next turn sees does not.
    const [first, retry] = agent.model.requests.slice(-2);
    expect(first!.messages.at(-1)!.content).toEqual([{ text: 'hello' }]);
    expect(retry!.messages.at(-1)!.content).toEqual([{ text: 'hello' }, { text: EMPTY_REPLY_NUDGE }]);

    agent.model.push(...Array.from({ length: EMPTY_REPLY_RETRIES + 1 }, () => silent));
    await chat(agent, 'are you there?');
    expect((await lastMessage(agent)).speech).toBe(TURN_FAILED);
    agent.model.push(say('Yes.'));
    await chat(agent, 'hello?');
    expect(JSON.stringify(agent.model.requests.at(-1)!.messages)).not.toContain(EMPTY_REPLY_NUDGE);
  });

  it('does not advance a step the user never heard', async () => {
    await stockKitchen(kitchen, { egg: 6, tomato: 4, 'olive oil': 100, scallion: 2 });
    await callWriteStart();
    agent.model.push(callTools(['next_step']), (req) => {
      expect(lastToolResults(req)[0]).toMatchObject({ code: 'no_step_heard' });
      return say('Let me read the current step first.');
    });
    await chat(agent, 'next');
    const [session] = await withAdmin(async (admin) =>
      (await admin.query(`SELECT current_step FROM pantry.cooking_sessions WHERE household_id = $1`, [kitchen.householdId])).rows,
    );
    expect(session).toEqual({ current_step: 1 });
  });

  it('adds groceries, cooks the recipe step by step, and records what was used', async () => {
    await stockKitchen(kitchen, { tomato: 4, 'olive oil': 100, scallion: 2 });

    // Intake: the model proposes, the app reads the card back, "yes" confirms with no model call.
    agent.model.push(callTools(['propose_intake', { items: [{ name: 'eggs', quantity: 12 }] }]), say('Got it.'));
    expect((await chat(agent, 'I bought a dozen eggs')).status).toBe(200);
    const intakeCard = await lastMessage(agent);
    expect(intakeCard).toMatchObject({
      turn_type: 'user',
      speech: "Got it. I'll add 12 eggs. Say confirm, or tell me what to change.",
      voice_prompt: { kind: 'proposal_confirm', version: 1 },
      cards: [expect.objectContaining({ type: 'proposal', kind: 'intake', version: 1 })],
    });
    const calls = agent.model.requests.length;
    expect((await answer('Yes')).status).toBe(200);
    expect(agent.model.requests).toHaveLength(calls); // the gate made no model call
    expect(await lastMessage(agent)).toMatchObject({ turn_type: 'gate', speech: 'Done — added to your stock.' });
    expect(await eggs()).toBe(12);

    // Cooking: step 1 has no timer; "next" reaches step 2, whose timer the app offers.
    agent.model.push(callTools(['start_cooking', { recipe_name: 'tomato egg stir-fry' }]), say('Step 1: beat the eggs.'));
    await chat(agent, "Let's make tomato egg stir-fry");
    const step1 = await lastMessage(agent);
    expect(step1).toMatchObject({ step_no: 1, voice_prompt: null, cards: [expect.objectContaining({ type: 'step', step_no: 1 })] });
    expect(agent.model.requests.at(-1)!.messages.at(-1)!.content).toEqual([
      expect.objectContaining({ toolResult: expect.objectContaining({ status: 'success' }) }),
    ]);

    agent.model.push(callTools(['next_step']), (req) => say(`Step ${lastToolResults(req)[0]!.step_no}.`));
    await chat(agent, 'next');
    expect(await lastMessage(agent)).toMatchObject({
      speech: 'Step 2. This step takes 1 minute — start a timer?',
      step_no: 2,
      voice_prompt: { kind: 'timer_offer', label: 'eggs', seconds: 60, step_no: 2 },
    });
    // expected_step was injected from what the user heard, not chosen by the model.
    const [nextCall] = await agentRows<{ final_input: Record<string, unknown> }>(
      agent,
      `SELECT final_input FROM agent.tool_calls WHERE conversation_id = $1 AND name = 'next_step'`,
      [agent.conversationId],
    );
    expect(nextCall!.final_input).toEqual({ expected_step: 1 });

    // "Sure" starts the offered timer, again with no model call.
    expect((await answer('sure')).status).toBe(200);
    expect(await lastMessage(agent)).toMatchObject({ turn_type: 'gate', speech: 'Timer started: 1 minute.' });
    expect(await agentRows(agent, `SELECT label, seconds, status, step_no FROM agent.timers WHERE conversation_id = $1`, [agent.conversationId])).toEqual([
      { label: 'eggs', seconds: 60, status: 'running', step_no: 2 },
    ]);

    // "next, next" in one turn: the second call expects the step the first one delivered.
    agent.model.push(callTools(['next_step'], ['next_step']), say('On to the last step.'));
    await chat(agent, 'next, and next again');
    expect(await lastMessage(agent)).toMatchObject({ step_no: 4 });

    // "next" on the last step: done → propose_consumption → read back → "confirm" commits.
    agent.model.push(callTools(['next_step']), callTools(['propose_consumption']), say("That's the last step."));
    await chat(agent, 'next');
    const consumeCard = await lastMessage(agent);
    expect(consumeCard.voice_prompt).toMatchObject({ kind: 'proposal_confirm' });
    expect(consumeCard.speech).toMatch(/^That's the last step\. I'll record .*Say confirm, or tell me what to change\.$/);
    expect((await answer('confirm')).status).toBe(200);
    expect(await lastMessage(agent)).toMatchObject({ speech: 'Done — recorded what you used.' });
    expect(await eggs()).toBe(9);

    const [session] = await withAdmin(async (admin) =>
      (await admin.query(`SELECT state FROM pantry.cooking_sessions WHERE household_id = $1`, [kitchen.householdId])).rows,
    );
    expect(session).toEqual({ state: 'consumed' });
    const confirmations = await withAdmin(async (admin) =>
      (await admin.query(`SELECT channel, utterance FROM pantry.confirmations WHERE household_id = $1 AND channel = 'voice_rule' ORDER BY confirmed_at`, [kitchen.householdId]))
        .rows,
    );
    expect(confirmations).toEqual([
      { channel: 'voice_rule', utterance: 'yes' },
      { channel: 'voice_rule', utterance: 'confirm' },
    ]);
    expect(agent.model.remaining).toBe(0);
  });
});
