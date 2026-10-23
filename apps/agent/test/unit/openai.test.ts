import { describe, expect, it } from 'vitest';
import { fromChatResponse, OpenAICompatibleModel, toChatRequest } from '../../src/model/openai.ts';
import type { ModelRequest } from '../../src/model/types.ts';

const OPTIONS = { baseUrl: 'http://127.0.0.1:11434/v1/', model: 'qwen3:8b', maxTokens: 512, timeoutMs: 5000 };

const REQUEST: ModelRequest = {
  system: 'be brief',
  messages: [
    { role: 'user', content: [{ text: 'what do I have?' }] },
    { role: 'assistant', content: [{ text: 'Let me check.' }, { toolUse: { toolUseId: 't1', name: 'list_inventory', input: {} } }, { toolUse: { toolUseId: 't2', name: 'expiring_soon', input: { days: 3 } } }] },
    {
      role: 'user',
      content: [
        { toolResult: { toolUseId: 't1', status: 'success', content: [{ json: { items: [] } }] } },
        { toolResult: { toolUseId: 't2', status: 'error', content: [{ json: { code: 'x' } }, { text: 'bad days' }] } },
        { text: '[app event] timer fired' },
      ],
    },
    { role: 'assistant', content: [{ text: '' }] },
  ],
  tools: [{ name: 'list_inventory', description: 'd', inputSchema: { type: 'object' } }],
};

describe('Chat Completions mapping', () => {
  it('sends the system prompt, tool calls and results in order, the tools and a capped, deterministic config', () => {
    expect(toChatRequest(REQUEST, OPTIONS)).toEqual({
      model: 'qwen3:8b',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'what do I have?' },
        {
          role: 'assistant',
          content: 'Let me check.',
          tool_calls: [
            { id: 't1', type: 'function', function: { name: 'list_inventory', arguments: '{}' } },
            { id: 't2', type: 'function', function: { name: 'expiring_soon', arguments: '{"days":3}' } },
          ],
        },
        // Tool results first, straight after the calls; the text of the same message after them.
        { role: 'tool', tool_call_id: 't1', content: '{"items":[]}' },
        { role: 'tool', tool_call_id: 't2', content: 'Error: {"code":"x"}\nbad days' },
        { role: 'user', content: '[app event] timer fired' },
        { role: 'assistant', content: '' },
      ],
      tools: [{ type: 'function', function: { name: 'list_inventory', description: 'd', parameters: { type: 'object' } } }],
      max_tokens: 512,
      temperature: 0,
    });
    expect(toChatRequest({ system: 's', messages: [], tools: [] }, OPTIONS)).not.toHaveProperty('tools');
    // Tool calls alone: null content, as the API expects.
    const calls = toChatRequest({ system: 's', messages: [{ role: 'assistant', content: [{ toolUse: { toolUseId: 'a', name: 'n', input: undefined } }] }], tools: [] }, OPTIONS);
    expect(calls.messages[1]).toEqual({ role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'n', arguments: '{}' } }] });
  });

  it('leaves out schema patterns OpenAI cannot parse, keeping the rest of the schema', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string', pattern: '^[^\\p{Cc}]*$', maxLength: 80 },
        note: { anyOf: [{ type: 'string', pattern: '^[^\\P{L}]+$' }, { type: 'null' }] },
        code: { type: 'string', pattern: '^[a-z]+$' },
        pattern: { type: 'string' },
      },
      required: ['name'],
    };
    const [tool] = toChatRequest({ system: 's', messages: [], tools: [{ name: 't', description: 'd', inputSchema: schema }] }, OPTIONS).tools!;
    expect(tool!.function.parameters).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: 80 },
        note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        code: { type: 'string', pattern: '^[a-z]+$' },
        pattern: { type: 'string' },
      },
      required: ['name'],
    });
  });

  it('reads text, tool calls and usage back', () => {
    expect(
      fromChatResponse({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: 'Let me check.',
              tool_calls: [
                { id: 'call_1', function: { name: 'expiring_soon', arguments: '{"days":3}' } },
                { id: 'call_2', function: { name: 'list_inventory', arguments: '' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 900, completion_tokens: 40 },
      }),
    ).toEqual({
      stopReason: 'tool_use',
      content: [
        { text: 'Let me check.' },
        { toolUse: { toolUseId: 'call_1', name: 'expiring_soon', input: { days: 3 } } },
        { toolUse: { toolUseId: 'call_2', name: 'list_inventory', input: {} } },
      ],
      usage: { inputTokens: 900, outputTokens: 40 },
    });
    expect(fromChatResponse({ choices: [{ finish_reason: 'stop', message: { content: 'You have 6 eggs.' } }] })).toEqual({
      stopReason: 'end_turn',
      content: [{ text: 'You have 6 eggs.' }],
    });
    expect(fromChatResponse({})).toEqual({ stopReason: 'end_turn', content: [] });
    // Some local servers leave out the call id; the turn loop needs one to pair the result.
    const [use] = fromChatResponse({ choices: [{ message: { tool_calls: [{ function: { name: 'list_inventory', arguments: '{}' } }] } }] }).content;
    expect(use).toMatchObject({ toolUse: { name: 'list_inventory', input: {} } });
    expect((use as { toolUse: { toolUseId: string } }).toolUse.toolUseId).not.toBe('');
  });

  it('drops a reply cut off by the token cap or with broken tool arguments, so the turn loop asks again', () => {
    expect(fromChatResponse({ choices: [{ finish_reason: 'length', message: { content: 'Okay, the user said they are done. I need' } }] })).toEqual({
      stopReason: 'max_tokens',
      content: [],
    });
    for (const args of ['{"days":', '[1]', 'null']) {
      expect(fromChatResponse({ choices: [{ finish_reason: 'tool_calls', message: { content: 'ok', tool_calls: [{ id: 'c', function: { name: 'n', arguments: args } }] } }] })).toEqual({
        stopReason: 'malformed_tool_use',
        content: [],
      });
    }
    expect(fromChatResponse({ choices: [{ message: { tool_calls: [{ id: 'c', function: { arguments: '{}' } }] } }] }).content).toEqual([]);
  });

  it('strips <think> and <thinking> text so it is never spoken', () => {
    const reply = (content: string) => fromChatResponse({ choices: [{ finish_reason: 'stop', message: { content } }] }).content;
    expect(reply('<think>\nThe user wants eggs.\n</think>\n\nYou have 6 eggs.')).toEqual([{ text: 'You have 6 eggs.' }]);
    expect(reply('<thinking>a</thinking>Done.')).toEqual([{ text: 'Done.' }]);
    expect(reply('Sure. <think> the user wants')).toEqual([{ text: 'Sure.' }]);
    expect(reply('<think>only thoughts</think>')).toEqual([]);
  });
});

describe('OpenAICompatibleModel', () => {
  const fakeFetch = (status: number, body: unknown) => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { calls, impl };
  };

  it('posts to <baseUrl>/chat/completions, with the key as a bearer token when there is one', async () => {
    const withKey = fakeFetch(200, { choices: [{ finish_reason: 'stop', message: { content: 'hi' } }] });
    const reply = await new OpenAICompatibleModel({ ...OPTIONS, apiKey: 'sk-test' }, withKey.impl).converse(REQUEST);
    expect(reply).toEqual({ stopReason: 'end_turn', content: [{ text: 'hi' }] });
    const [{ url, init }] = withKey.calls as [{ url: string; init: RequestInit }];
    expect(url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer sk-test' });
    expect(JSON.parse(init.body as string)).toEqual(toChatRequest(REQUEST, OPTIONS));
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const noKey = fakeFetch(200, {});
    await new OpenAICompatibleModel(OPTIONS, noKey.impl).converse(REQUEST);
    expect(noKey.calls[0]!.init.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('fails the call on an error status, with the reason the server gave', async () => {
    const { impl } = fakeFetch(404, '{"error":{"message":"model \\"qwen3:8b\\" not found"}}');
    await expect(new OpenAICompatibleModel(OPTIONS, impl).converse(REQUEST)).rejects.toThrow(/404 .*not found/);
  });
});
