// The agent on an OpenAI-compatible model: a real turn (MCP tools, history, grounding) against a fake
// Chat Completions server that replays scripted replies and records what it was sent.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type RunningServers, startServers } from '@pantrymos/mcp-server';
import { createDemoKitchen, type DemoKitchen, mcpTestConfig, stockKitchen } from '../../../../test/fixtures.ts';
import { OpenAICompatibleModel } from '../../src/model/openai.ts';
import { chat, lastMessage, startAgentWith, type TestAgent } from '../fixtures.ts';

interface Received {
  url: string;
  authorization: string | undefined;
  body: { model: string; messages: Array<Record<string, unknown>>; tools?: Array<{ function: { name: string } }> };
}

describe('the agent on an OpenAI-compatible model', () => {
  let servers: RunningServers;
  let fake: Server;
  let baseUrl: string;
  const received: Received[] = [];
  const replies: unknown[] = [];

  beforeAll(async () => {
    servers = await startServers(mcpTestConfig(), { log: false });
    fake = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        received.push({ url: req.url ?? '', authorization: req.headers.authorization, body: JSON.parse(raw) });
        const reply = replies.shift();
        res.writeHead(reply ? 200 : 500, { 'content-type': 'application/json' }).end(JSON.stringify(reply ?? { error: 'unscripted call' }));
      });
    });
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;
  });
  afterAll(async () => {
    await new Promise((resolve) => fake.close(resolve));
    await servers.close();
  });

  let kitchen: DemoKitchen;
  let agent: TestAgent<OpenAICompatibleModel>;
  beforeEach(async () => {
    received.length = 0;
    replies.length = 0;
    kitchen = await createDemoKitchen();
    agent = await startAgentWith(new OpenAICompatibleModel({ baseUrl, apiKey: 'sk-test', model: 'fake-model', maxTokens: 512, timeoutMs: 5000 }), servers, kitchen);
  });
  afterEach(async () => agent.close());

  it('runs a kitchen tool the model asks for and sends its result back as a tool message', async () => {
    await stockKitchen(kitchen, { egg: 6 });
    replies.push(
      { choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_inventory', arguments: '{}' } }] } }] },
      { choices: [{ finish_reason: 'stop', message: { content: '<think>Read the stock.</think>You have some eggs and milk.' } }] },
    );
    expect((await chat(agent, 'what do I have?')).status).toBe(200);
    expect((await lastMessage(agent)).speech).toBe('You have some eggs and milk.');

    expect(received).toHaveLength(2);
    const [first, second] = received as [Received, Received];
    expect(first.url).toBe('/v1/chat/completions');
    expect(first.authorization).toBe('Bearer sk-test');
    expect(first.body.model).toBe('fake-model');
    expect(first.body.messages[0]).toMatchObject({ role: 'system' });
    expect(first.body.messages.at(-1)).toEqual({ role: 'user', content: 'what do I have?' });
    // The tool list comes from MCP tools/list, plus the agent's own timer tools.
    const tools = first.body.tools!.map((t) => t.function.name);
    expect(tools).toEqual(expect.arrayContaining(['list_inventory', 'propose_intake', 'start_timer']));
    expect(tools).not.toContain('confirm');

    // The call, then its result straight after it, paired by id.
    const [call, result] = second.body.messages.slice(-2) as [Record<string, unknown>, { role: string; tool_call_id: string; content: string }];
    expect(call).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'call_1', function: { name: 'list_inventory', arguments: '{}' } }] });
    expect(result).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
    expect(result.content).toContain('egg');
  });

  it('asks again after a reply cut off by the token cap, and never speaks it', async () => {
    replies.push(
      { choices: [{ finish_reason: 'length', message: { content: 'Okay, the user wants to know what' } }] },
      { choices: [{ finish_reason: 'stop', message: { content: 'Hi! What are we cooking?' } }] },
    );
    await chat(agent, 'hello');
    expect((await lastMessage(agent)).speech).toBe('Hi! What are we cooking?');
    expect(received).toHaveLength(2);
  });
});
