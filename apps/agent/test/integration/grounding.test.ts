// Guardrails on what Mos says (grounding.ts), in the turn loop: what is said, and what the model keeps.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type RunningServers, startServers } from '@pantrymos/mcp-server';
import { createDemoKitchen, type DemoKitchen, mcpTestConfig, stockKitchen } from '../../../../test/fixtures.ts';
import { NOT_CHANGED } from '../../src/turn/speech.ts';
import { ack, agentRows, callTools, cardAction, chat, lastMessage, say, startAgent, type TestAgent, voice } from '../fixtures.ts';

describe('grounding the reply', () => {
  let servers: RunningServers;
  beforeAll(async () => {
    servers = await startServers(mcpTestConfig(), { log: false });
  });
  afterAll(async () => servers.close());

  let kitchen: DemoKitchen;
  let agent: TestAgent;
  beforeEach(async () => {
    kitchen = await createDemoKitchen();
    agent = await startAgent(servers, kitchen);
  });
  afterEach(async () => agent.close());

  /** The model's last reply as kept in the conversation history. */
  const kept = async () =>
    (
      await agentRows<{ content: Array<{ text?: string }> }>(
        agent,
        `SELECT content FROM agent.conversation_messages WHERE conversation_id = $1 AND role = 'assistant' ORDER BY seq DESC LIMIT 1`,
        [agent.conversationId],
      )
    )[0]!.content;

  it('says the card, not a claim that the change was made, and keeps no such claim in the history', async () => {
    await stockKitchen(kitchen, { egg: 12 });
    agent.model.push(
      callTools(['propose_adjustment', { item: 'egg', delta: -2, reason: 'discard' }]),
      say("Oops. I've recorded that 2 eggs were thrown out."),
    );
    await chat(agent, 'I dropped two eggs');
    expect((await lastMessage(agent)).speech).toBe("Oops. I'll record that 2 eggs were thrown out. Say confirm, or tell me what to change.");
    expect(await kept()).toEqual([{ text: 'Oops.' }]);
  });

  it('says a templated line when the reply was only a false claim and there is no card', async () => {
    agent.model.push(say('All ingredients have been deducted.'));
    await chat(agent, 'just deduct it');
    expect((await lastMessage(agent)).speech).toBe(NOT_CHANGED);
    expect(await kept()).toEqual([{ text: NOT_CHANGED }]);
  });

  it('lets the model say what was saved once it heard of the commit', async () => {
    await stockKitchen(kitchen, { egg: 12 });
    agent.model.push(callTools(['propose_adjustment', { item: 'egg', delta: -2, reason: 'discard' }]), say('OK.'));
    await chat(agent, 'I dropped two eggs');
    const card = (await lastMessage(agent)).voice_prompt as { proposal_id: string };
    expect((await cardAction(agent, 'POST', `/api/proposals/${card.proposal_id}/confirm`, { version: 1 })).status).toBe(200);
    // The button's commit is acknowledged in a proactive turn, whose input is the commit.
    agent.model.push(say("I've recorded the 2 eggs you threw out."));
    await agent.workers.tickEvents();
    await agent.workers.drain();
    expect(await lastMessage(agent)).toMatchObject({ turn_type: 'proactive', speech: "I've recorded the 2 eggs you threw out." });

    // A later turn heard of no commit: the same claim is not said again.
    agent.model.push(say("I've recorded the 2 eggs you threw out."));
    await chat(agent, 'thanks');
    expect((await lastMessage(agent)).speech).toBe(NOT_CHANGED);
  });

  it('reads the recipe step itself when the model recites one, right or wrong', async () => {
    await stockKitchen(kitchen, { egg: 6, tomato: 4, 'olive oil': 100, scallion: 2 });
    agent.model.push(callTools(['start_cooking', { recipe_name: 'tomato egg stir-fry' }]), say("Let's go. Step 1: heat a wok until it smokes."));
    await chat(agent, 'cook the stir-fry');
    const step = await lastMessage(agent);
    expect(step.speech).toBe("Let's go. Step 1: Beat the eggs with a pinch of salt and cut the tomatoes into wedges.");
    expect(await ack(agent, step.id)).toMatchObject({ status: 404 }); // a step with no timer asks nothing

    // A reply with no step tool called gets no step said at all.
    agent.model.push(say('The second step is to fry the rice.'));
    expect((await voice(agent, 'what now?')).status).toBe(200);
    expect((await lastMessage(agent)).speech).not.toMatch(/step/i);
  });
});
