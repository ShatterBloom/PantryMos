// Choosing the model in the app: the configured providers, a choice kept across restarts, turns on
// the chosen one, a switch mid-conversation, and nothing chosen yet.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type RunningServers, startServers } from '@pantrymos/mcp-server';
import { createDemoKitchen, type DemoKitchen, mcpTestConfig } from '../../../../test/fixtures.ts';
import type { ModelConfig, Provider } from '../../src/config.ts';
import { createPool, type Pool } from '../../src/db.ts';
import { ChosenModel, ModelChoice } from '../../src/model/choice.ts';
import { chat, lastMessage, say, ScriptedModel, startAgentWith, type TestAgent } from '../fixtures.ts';
import { TEST_AGENT_DB_URL } from '../../../../test/env.ts';

const BEDROCK: ModelConfig = { provider: 'bedrock', region: 'ap-southeast-2', modelId: 'test-nova', maxTokens: 512 };
const OPENAI: ModelConfig = { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-test', maxTokens: 512, timeoutMs: 1000 };

describe('choosing the model in the app', () => {
  let servers: RunningServers;
  let pool: Pool;
  beforeAll(async () => {
    servers = await startServers(mcpTestConfig(), { log: false });
    pool = createPool(TEST_AGENT_DB_URL);
  });
  afterAll(async () => {
    await pool.end();
    await servers.close();
  });

  let kitchen: DemoKitchen;
  let nova: ScriptedModel;
  let gpt: ScriptedModel;
  let agent: TestAgent<ChosenModel>;
  const agents: Array<TestAgent<ChosenModel>> = [];

  /** An agent offering `configs`, each on its own scripted model, turns on the chosen one. */
  const start = async (configs: ModelConfig[]) => {
    const choice = new ModelChoice(pool, configs.map((c) => c.provider));
    const clients = new Map<Provider, ScriptedModel>([
      ['bedrock', nova],
      ['openai', gpt],
    ]);
    const started = await startAgentWith(new ChosenModel(choice, clients), servers, kitchen, { config: { models: configs }, choice });
    agents.push(started);
    return started;
  };
  const status = async (a = agent) => (await a.api({ method: 'GET', url: '/api/model' })).json();
  const choose = (provider: string, a = agent) => a.api({ method: 'POST', url: '/api/model/choice', payload: { provider } });

  beforeEach(async () => {
    await pool.query('DELETE FROM agent.model_choice');
    kitchen = await createDemoKitchen();
    nova = new ScriptedModel();
    gpt = new ScriptedModel();
    agent = await start([BEDROCK, OPENAI]);
  });
  afterEach(async () => {
    for (const a of agents.splice(0)) await a.close();
  });

  it('lists every provider, with the ones not set up, and nothing chosen yet', async () => {
    expect(await status()).toEqual({
      current: null,
      models: [
        { provider: 'bedrock', configured: true, model: 'test-nova' },
        { provider: 'openai', configured: true, model: 'gpt-test' },
        { provider: 'chatgpt', configured: false, model: null },
      ],
      chatgpt: null,
    });
  });

  it('answers a chat with "choose a model" until one is chosen, calling no model', async () => {
    const res = await chat(agent, 'hi');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'model_unavailable', reason: 'not_chosen' });
    expect(nova.requests).toHaveLength(0);
    expect(gpt.requests).toHaveLength(0);
  });

  it('runs turns on the chosen model, and on the other after a switch in the same conversation', async () => {
    expect((await choose('openai')).json()).toMatchObject({ current: 'openai' });
    gpt.push(say('Hi from GPT.'));
    expect((await chat(agent, 'hi')).status).toBe(200);
    expect((await lastMessage(agent)).speech).toBe('Hi from GPT.');

    expect((await choose('bedrock')).statusCode).toBe(200);
    nova.push(say('Hi from Nova.'));
    expect((await chat(agent, 'and again')).status).toBe(200);
    expect((await lastMessage(agent)).speech).toBe('Hi from Nova.');
    // Nova carries on the same conversation: it is sent what GPT said.
    expect(JSON.stringify(nova.requests[0]!.messages)).toContain('Hi from GPT.');
    expect(gpt.requests).toHaveLength(1);
  });

  it('keeps the choice across a restart', async () => {
    await choose('openai');
    const again = await start([BEDROCK, OPENAI]);
    expect((await status(again)).current).toBe('openai');
  });

  it('refuses a provider not set up or unknown, and keeps the choice', async () => {
    await choose('bedrock');
    const unset = await choose('chatgpt');
    expect(unset.statusCode).toBe(409);
    expect(unset.json()).toMatchObject({ code: 'model_not_configured' });
    expect((await choose('gemini')).statusCode).toBe(400);
    expect((await agent.api({ method: 'POST', url: '/api/model/choice', payload: {} })).statusCode).toBe(400);
    expect((await status()).current).toBe('bedrock');
  });

  it('takes the only one configured without asking, and drops a choice no longer configured', async () => {
    await choose('openai');
    const novaOnly = await start([BEDROCK]);
    expect((await status(novaOnly)).current).toBe('bedrock');
    // With two offered again, the old choice still applies.
    expect((await status()).current).toBe('openai');
  });

  it('needs the session and the app origin to choose', async () => {
    const anon = await agent.app.inject({ method: 'POST', url: '/api/model/choice', headers: { origin: 'http://localhost:7400' }, payload: { provider: 'bedrock' } });
    expect(anon.statusCode).toBe(401);
    const foreign = await agent.api({ method: 'POST', url: '/api/model/choice', headers: { origin: 'https://evil.example' }, payload: { provider: 'bedrock' } });
    expect(foreign.statusCode).toBe(403);
    expect((await status()).current).toBeNull();
  });

  it('keeps one choice when two arrive at once', async () => {
    const results = await Promise.all(['bedrock', 'openai', 'bedrock', 'openai'].map((p) => choose(p)));
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200]);
    expect((await pool.query('SELECT count(*)::int AS n FROM agent.model_choice')).rows[0].n).toBe(1);
    expect(['bedrock', 'openai']).toContain((await status()).current);
  });
});
