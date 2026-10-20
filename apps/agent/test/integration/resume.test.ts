// Crash and retry (§5.2, §8.2): G11, G12 and the chat request log. A crash is a failed statement or
// MCP call mid-turn; the client then retries the same chat request, which resumes the turn.
import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type RunningServers, startServers } from '@pantrymos/mcp-server';
import { connectMcp } from '../../src/mcpClient.ts';
import { createDemoKitchen, type DemoKitchen, mcpTestConfig, stockKitchen, withAdmin } from '../../../../test/fixtures.ts';
import { agentRows, agentTestConfig, callTools, chat, crashOnce, lastMessage, say, startAgent, type TestAgent } from '../fixtures.ts';

describe('resuming a crashed turn', () => {
  let servers: RunningServers;
  beforeAll(async () => {
    servers = await startServers(mcpTestConfig(), { log: false });
  });
  afterAll(async () => servers.close());

  let kitchen: DemoKitchen;
  let agent: TestAgent;
  /** Set to make the next MCP call of that tool fail before (or after) the server runs it. */
  let mcpCrash: { tool: string; when: 'before' | 'after' } | null;
  beforeEach(async () => {
    kitchen = await createDemoKitchen();
    mcpCrash = null;
    const config = agentTestConfig(servers, kitchen);
    agent = await startAgent(servers, kitchen, {
      connectMcp: async () => {
        const client: Client = await connectMcp(config.mcpUrl, config.mcpToken);
        const callTool = client.callTool.bind(client);
        client.callTool = (async (params: Parameters<Client['callTool']>[0], ...rest: unknown[]) => {
          const crash = mcpCrash?.tool === params.name ? mcpCrash : null;
          if (crash?.when === 'before') {
            mcpCrash = null;
            throw new Error('connection lost before the call');
          }
          const result = await callTool(params, ...(rest as []));
          if (crash) {
            mcpCrash = null;
            throw new Error('connection lost after the call');
          }
          return result;
        }) as Client['callTool'];
        return client;
      },
    });
  });
  afterEach(async () => agent.close());

  const currentStep = async () =>
    withAdmin(async (admin) =>
      (await admin.query(`SELECT current_step FROM pantry.cooking_sessions WHERE household_id = $1 AND state = 'cooking'`, [kitchen.householdId]))
        .rows[0].current_step,
    );
  const userMessages = async () =>
    agentRows<{ n: number }>(agent, `SELECT count(*)::int AS n FROM agent.conversation_messages WHERE conversation_id = $1 AND role = 'user'`, [
      agent.conversationId,
    ]);

  it('G11: a next_step recorded but never run is run once on retry, with its original expected_step', async () => {
    await stockKitchen(kitchen, { egg: 6, tomato: 4, 'olive oil': 100, scallion: 2 });
    agent.model.push(callTools(['start_cooking', { recipe_name: 'tomato egg stir-fry' }]), say('Step 1.'));
    await chat(agent, 'cook the stir-fry');

    const requestId = randomUUID();
    mcpCrash = { tool: 'next_step', when: 'before' };
    agent.model.push(callTools(['next_step']));
    expect((await chat(agent, 'next', { requestId })).status).toBe(500);
    expect(await currentStep()).toBe(1);
    const [pending] = await agentRows(agent, `SELECT status, final_input FROM agent.tool_calls WHERE conversation_id = $1 AND name = 'next_step'`, [
      agent.conversationId,
    ]);
    expect(pending).toEqual({ status: 'pending', final_input: { expected_step: 1 } });

    const calls = agent.model.requests.length;
    agent.model.push(say('Step 2.'));
    const retried = await chat(agent, 'next', { requestId });
    expect(retried.status).toBe(200);
    expect(agent.model.requests).toHaveLength(calls + 1); // only the closing reply; next_step was not re-decided
    expect(await currentStep()).toBe(2);
    expect(await userMessages()).toEqual([{ n: 4 }]); // two user turns + two tool-result messages, none repeated
    expect(await lastMessage(agent)).toMatchObject({ speech: 'Step 2. This step takes 1 minute — start a timer?', step_no: 2 });

    // A third try of the same request replays the stored response.
    expect((await chat(agent, 'next', { requestId })).body).toEqual({ message_ids: retried.body.message_ids });
    expect(await currentStep()).toBe(2);
  });

  it('G12: add_to_shopping_list that ran before the crash adds one row on retry', async () => {
    const requestId = randomUUID();
    mcpCrash = { tool: 'add_to_shopping_list', when: 'after' };
    agent.model.push(callTools(['add_to_shopping_list', { items: [{ name: 'milk', quantity: 1, unit: 'l' }] }]));
    expect((await chat(agent, 'add milk to the list', { requestId })).status).toBe(500);
    agent.model.push(say('Added milk.'));
    expect((await chat(agent, 'add milk to the list', { requestId })).status).toBe(200);
    const rows = await withAdmin(async (admin) =>
      (await admin.query(`SELECT 1 FROM pantry.shopping_list_items WHERE household_id = $1`, [kitchen.householdId])).rows,
    );
    expect(rows).toHaveLength(1);
    expect(await lastMessage(agent)).toMatchObject({ speech: 'Added milk.' });
  });

  it('G12: start_timer that ran before its result was stored starts one timer on retry', async () => {
    const requestId = randomUUID();
    const crash = crashOnce(agent.pool, /UPDATE agent\.tool_calls SET status = 'done'/);
    agent.model.push(callTools(['start_timer', { label: 'pasta', seconds: 480 }]));
    expect((await chat(agent, 'set a pasta timer for 8 minutes', { requestId })).status).toBe(500);
    expect(crash.fired()).toBe(true);
    agent.model.push(say('Timer set.'));
    expect((await chat(agent, 'set a pasta timer for 8 minutes', { requestId })).status).toBe(200);
    expect(await agentRows(agent, `SELECT label, status FROM agent.timers WHERE conversation_id = $1`, [agent.conversationId])).toEqual([
      { label: 'pasta', status: 'running' },
    ]);
  });

  it('resumes a turn that crashed before its first model reply without repeating the user message', async () => {
    const requestId = randomUUID();
    agent.model.push(() => {
      throw new Error('model unavailable');
    });
    expect((await chat(agent, 'what can I cook?', { requestId })).status).toBe(500);
    agent.model.push(say('Pasta.'));
    expect((await chat(agent, 'what can I cook?', { requestId })).status).toBe(200);
    expect(await userMessages()).toEqual([{ n: 1 }]);
    expect(agent.model.requests.at(-1)!.messages).toEqual([{ role: 'user', content: [{ text: 'what can I cook?' }] }]);
  });

  it('refuses a reused request_id with other text, and one still running', async () => {
    const requestId = randomUUID();
    agent.model.push(say('Hi.'));
    await chat(agent, 'hello', { requestId });
    expect(await chat(agent, 'something else', { requestId })).toMatchObject({ status: 409, body: { code: 'request_conflict' } });

    let release!: () => void;
    agent.model.push(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return say('Done.');
    });
    const running = randomUUID();
    const first = chat(agent, 'slow one', { requestId: running });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await chat(agent, 'slow one', { requestId: running });
    expect(second).toMatchObject({ status: 409, body: { code: 'request_in_progress' } });
    expect(Number(second.headers['retry-after'])).toBeGreaterThan(0);
    release();
    expect((await first).status).toBe(200);
  });
});
