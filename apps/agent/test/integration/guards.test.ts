// Inputs the app sets and limits it enforces on tool calls, whatever the model asks for.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type RunningServers, startServers } from '@pantrymos/mcp-server';
import {
  addScallionSubstitute,
  callWrite,
  confirmCard,
  connectMcpClient,
  createDemoKitchen,
  type DemoKitchen,
  eatMeal,
  mcpTestConfig,
  PASTA_STOCK,
  stockKitchen,
} from '../../../../test/fixtures.ts';
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

  it('proposes the meal only in a turn that gave no new step (eval P9: the last step and the card at once)', async () => {
    await stockKitchen(kitchen, { egg: 6, tomato: 4, 'olive oil': 100, scallion: 2 });
    agent.model.push(callTools(['start_cooking', { recipe_name: 'tomato egg stir-fry' }]), say('OK.'));
    await chat(agent, 'cook the stir-fry');

    agent.model.push(callTools(['next_step'], ['propose_consumption']), (req) => {
      expect(lastToolResults(req).map((r) => r.code ?? r.step_no)).toEqual([2, 'step_not_heard']);
      return say('OK.');
    });
    await chat(agent, 'next');

    agent.model.push(callTools(['propose_consumption']), (req) => {
      expect(lastToolResults(req)[0]).toMatchObject({ kind: 'consume' });
      return say('OK.');
    });
    await chat(agent, "I'm done");
  });

  it('takes a share only when the user named one (eval P12: "300 ml" made half the milk)', async () => {
    await stockKitchen(kitchen, { milk: 1000 });
    const half = (of: string) => callTools(['propose_adjustment', { item: 'milk', reason: 'discard', share: { fraction: 0.5, of } }]);

    agent.model.push(half('stock'), (req) => {
      expect(lastToolResults(req)[0]).toMatchObject({ code: 'no_share_said' });
      return callTools(['propose_adjustment', { item: 'milk', reason: 'discard', delta: -300 }]);
    }, (req) => {
      expect(lastToolResults(req)[0]).toMatchObject({ kind: 'adjust' });
      return say('OK.');
    });
    await chat(agent, 'I spilled 300 ml of milk');

    agent.model.push(half('stock'), (req) => {
      expect(lastToolResults(req)[0]).toMatchObject({ kind: 'adjust' });
      return say('OK.');
    });
    await chat(agent, 'Actually it was half the milk');
  });

  it("says the user chose an undo's scope only when their words say which, whatever the model claims (eval P16)", async () => {
    // A corrected meal: "undo that" could mean the correction or the whole meal (PRD FR-21).
    await stockKitchen(kitchen, { egg: 6, tomato: 4, 'olive oil': 100, scallion: 2 });
    const mcp = await connectMcpClient(servers, kitchen.token);
    const { sessionId } = await eatMeal(servers, mcp, 'tomato egg stir-fry');
    const revision = (await callWrite(mcp, 'propose_consumption_revision', { usage: [{ item: 'egg', quantity: 4 }] })).structuredContent as {
      proposal_id: string;
      version: number;
    };
    expect((await confirmCard(servers, revision, revision.version)).status).toBe(200);
    await mcp.close();

    // Nova went straight for the meal by id, claiming the choice; the server asks instead.
    agent.model.push(callTools(['propose_undo', { target: sessionId, scope: 'session', scope_chosen_by_user: true }]), (req) => {
      expect(lastToolResults(req)[0]).toMatchObject({ code: 'ambiguous_undo', ask: 'Undo just the correction, or the whole tomato egg stir-fry?' });
      return say('Undo just the correction, or the whole tomato egg stir-fry?');
    });
    await chat(agent, 'Undo that');

    agent.model.push(callTools(['propose_undo', { target: sessionId, scope: 'session' }]), (req) => {
      expect(lastToolResults(req)[0]).toMatchObject({ kind: 'undo', scope: 'session' });
      return say('OK.');
    });
    await chat(agent, 'The whole meal');

    const inputs = await agentRows<{ final_input: { scope_chosen_by_user: boolean } }>(
      agent,
      `SELECT final_input FROM agent.tool_calls WHERE conversation_id = $1 AND name = 'propose_undo' ORDER BY created_at`,
      [agent.conversationId],
    );
    expect(inputs.map((r) => r.final_input.scope_chosen_by_user)).toEqual([false, true]);
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
