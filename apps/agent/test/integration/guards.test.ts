// Inputs the app sets and limits it enforces on tool calls, whatever the model asks for.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type RunningServers, startServers } from '@pantrymos/mcp-server';
import { addScallionSubstitute, createDemoKitchen, type DemoKitchen, mcpTestConfig, PASTA_STOCK, stockKitchen } from '../../../../test/fixtures.ts';
import { agentRows, callTools, chat, lastToolResults, say, startAgent, type TestAgent } from '../fixtures.ts';

describe('tool-call guards', () => {
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

  const step = async () =>
    (
      await agentRows<{ step_no: number | null }>(
        agent,
        `SELECT step_no FROM agent.outbound_messages WHERE conversation_id = $1 AND step_no IS NOT NULL ORDER BY id DESC LIMIT 1`,
        [agent.conversationId],
      )
    )[0]?.step_no;

  it('moves one step per "next" the user said (eval P9: six next_step calls for one "next")', async () => {
    await stockKitchen(kitchen, { egg: 6, tomato: 4, 'olive oil': 100, scallion: 2 });
    agent.model.push(callTools(['start_cooking', { recipe_name: 'tomato egg stir-fry' }]), say('OK.'));
    await chat(agent, 'cook the stir-fry');

    agent.model.push(callTools(['next_step'], ['next_step'], ['next_step']), (req) => {
      expect(lastToolResults(req).map((r) => r.code ?? r.step_no)).toEqual([2, 'one_step_per_next', 'one_step_per_next']);
      return say('OK.');
    });
    await chat(agent, 'next');
    expect(await step()).toBe(2);

    agent.model.push(callTools(['next_step'], ['next_step']), say('OK.'));
    await chat(agent, 'next, next');
    expect(await step()).toBe(4);
  });

  it('says a substitute was chosen only when the user named it, whatever the model claims (eval G3)', async () => {
    const { scallion: _none, ...noScallion } = PASTA_STOCK;
    await stockKitchen(kitchen, { ...noScallion, onion: 2, 'bell pepper': 2 });
    await addScallionSubstitute(kitchen);
    const start = (chosen: boolean) =>
      callTools(['start_cooking', { recipe_name: 'creamy spinach pasta', substitutions: [{ from_item: 'scallion', to_item: 'onion', chosen_by_user: chosen }] }]);

    agent.model.push(start(true), (req) => {
      expect(lastToolResults(req)[0]).toMatchObject({ code: 'needs_choice', options: ['onion', 'bell pepper'] });
      return say('Onion or bell pepper?');
    });
    await chat(agent, "make dinner with what's going bad");

    agent.model.push(start(false), say('Started.'));
    await chat(agent, 'the onion, please');
    const inputs = await agentRows<{ final_input: { substitutions: Array<{ chosen_by_user: boolean }> } }>(
      agent,
      `SELECT final_input FROM agent.tool_calls WHERE conversation_id = $1 AND name = 'start_cooking' ORDER BY created_at`,
      [agent.conversationId],
    );
    expect(inputs.map((r) => r.final_input.substitutions[0]!.chosen_by_user)).toEqual([false, true]);
  });
});
