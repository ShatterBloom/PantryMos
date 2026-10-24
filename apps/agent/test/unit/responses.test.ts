import { describe, expect, it } from 'vitest';
import { ChatGPTPlanModel, fromResponsesOutput, toResponsesRequest } from '../../src/model/responses.ts';
import { type ModelRequest, ModelUnavailableError } from '../../src/model/types.ts';

const OPTIONS = { apiUrl: 'https://api.example.test/v1/', model: 'gpt-test', maxTokens: 100, timeoutMs: 5000, retryDelaysMs: [1, 1] };

const REQUEST: ModelRequest = {
  system: 'be brief',
  messages: [
    { role: 'user', content: [{ text: 'what do I have?' }] },
    { role: 'assistant', content: [{ text: 'Let me check.' }, { toolUse: { toolUseId: 't1', name: 'list_inventory', input: {} } }] },
    {
      role: 'user',
      content: [
        { toolResult: { toolUseId: 't1', status: 'error', content: [{ json: { code: 'x' } }] } },
        { text: '[app event] timer fired' },
      ],
    },
    { role: 'assistant', content: [{ text: '' }] },
  ],
  tools: [{ name: 'list_inventory', description: 'd', inputSchema: { type: 'object', properties: { q: { type: 'string', pattern: '^[^\\p{Cc}]*$' } } } }],
};

describe('Responses mapping', () => {
  it('sends the system prompt as instructions, the whole history as input, the tools, and store off, stream on', () => {
    expect(toResponsesRequest(REQUEST, 'gpt-test')).toEqual({
      model: 'gpt-test',
      instructions: 'be brief',
      input: [
        { role: 'user', content: 'what do I have?' },
        { role: 'assistant', content: 'Let me check.' },
        { type: 'function_call', call_id: 't1', name: 'list_inventory', arguments: '{}' },
        { type: 'function_call_output', call_id: 't1', output: 'Error: {"code":"x"}' },
        { role: 'user', content: '[app event] timer fired' },
      ],
      tools: [{ type: 'function', name: 'list_inventory', description: 'd', parameters: { type: 'object', properties: { q: { type: 'string' } } }, strict: false }],
      store: false,
      stream: true,
    });
    const bare = toResponsesRequest({ system: 's', messages: [], tools: [] }, 'gpt-test');
    expect(bare).not.toHaveProperty('tools');
    // The preview route refuses these.
    for (const field of ['temperature', 'max_output_tokens', 'previous_response_id']) expect(bare).not.toHaveProperty(field);
  });

  it('reads message text and function calls, dropping reasoning', () => {
    expect(
      fromResponsesOutput(
        [
          { type: 'reasoning' },
          { type: 'message', content: [{ type: 'output_text', text: '<think>stock</think>Let me ' }, { type: 'output_text', text: 'check.' }] },
          { type: 'function_call', call_id: 'c1', name: 'expiring_soon', arguments: '{"days":3}' },
          { type: 'function_call', call_id: 'c2', name: 'list_inventory', arguments: '' },
        ],
        { input_tokens: 900, output_tokens: 40 },
      ),
    ).toEqual({
      stopReason: 'tool_use',
      content: [
        { text: 'Let me check.' },
        { toolUse: { toolUseId: 'c1', name: 'expiring_soon', input: { days: 3 } } },
        { toolUse: { toolUseId: 'c2', name: 'list_inventory', input: {} } },
      ],
      usage: { inputTokens: 900, outputTokens: 40 },
    });
    expect(fromResponsesOutput([{ type: 'message', content: [{ type: 'output_text', text: 'Hi.' }] }])).toEqual({ stopReason: 'end_turn', content: [{ text: 'Hi.' }] });
    expect(fromResponsesOutput([{ type: 'function_call', call_id: 'c', name: 'n', arguments: '{"a":' }])).toEqual({ stopReason: 'malformed_tool_use', content: [] });
    expect(fromResponsesOutput([{ type: 'function_call', call_id: 'c', arguments: '{}' }]).content).toEqual([]);
  });
});

/** A Response whose body streams these events as server-sent events. */
const sse = (events: unknown[], { end = true } = {}) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        for (const e of events) controller.enqueue(enc.encode(`event: x\ndata: ${JSON.stringify(e)}\n\n`));
        if (end) controller.close();
        else controller.error(new Error('connection reset'));
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );

const completed = (output: unknown[]) => ({ type: 'response.completed', response: { output, usage: { input_tokens: 10, output_tokens: 2 } } });

function fakeFetch(...responses: Array<() => Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('unscripted fetch');
    return next();
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const tokens = { current: async () => ({ accessToken: 'access-1', model: 'gpt-plan-default' }) };

describe('ChatGPTPlanModel', () => {
  it('posts to /responses with the access token and reads the completed response', async () => {
    const f = fakeFetch(() =>
      sse([
        { type: 'response.created' },
        { type: 'response.output_text.delta', delta: 'Hi' },
        completed([{ type: 'message', content: [{ type: 'output_text', text: 'Hi there.' }] }]),
      ]),
    );
    expect(await new ChatGPTPlanModel(OPTIONS, tokens, f.impl).converse(REQUEST)).toEqual({
      stopReason: 'end_turn',
      content: [{ text: 'Hi there.' }],
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    const [{ url, init }] = f.calls as [{ url: string; init: RequestInit }];
    expect(url).toBe('https://api.example.test/v1/responses');
    expect(init.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer access-1' });
    expect(JSON.parse(init.body as string)).toEqual(toResponsesRequest(REQUEST, 'gpt-test'));
    // Without a configured model, the plan's default; without either, no request at all.
    const plan = fakeFetch(() => sse([completed([])]));
    await new ChatGPTPlanModel({ ...OPTIONS, model: undefined }, tokens, plan.impl).converse(REQUEST);
    expect(JSON.parse(plan.calls[0]!.init.body as string).model).toBe('gpt-plan-default');
    const none = fakeFetch();
    await expect(
      new ChatGPTPlanModel({ ...OPTIONS, model: undefined }, { current: async () => ({ accessToken: 'a', model: null }) }, none.impl).converse(REQUEST),
    ).rejects.toMatchObject({ reason: 'not_eligible' });
  });

  it('reads the items streamed one by one when the completed response leaves its output empty', async () => {
    // What ChatGPT's backend sends with store: false (seen on a real plan).
    const call = { type: 'function_call', call_id: 'call_1', name: 'list_inventory', arguments: '{}', status: 'completed' };
    const f = fakeFetch(() =>
      sse([
        { type: 'response.output_item.added', item: { ...call, arguments: '' } },
        { type: 'response.function_call_arguments.delta', delta: '{}' },
        { type: 'response.output_item.done', output_index: 0, item: call },
        completed([]),
      ]),
    );
    expect((await new ChatGPTPlanModel(OPTIONS, tokens, f.impl).converse(REQUEST)).content).toEqual([
      { toolUse: { toolUseId: 'call_1', name: 'list_inventory', input: {} } },
    ]);
  });

  it('stops a reply that streams past the cap, and drops one the server marks incomplete', async () => {
    const long = fakeFetch(() => sse(Array.from({ length: 50 }, () => ({ type: 'response.output_text.delta', delta: 'Okay, the user wants ' }))));
    expect(await new ChatGPTPlanModel(OPTIONS, tokens, long.impl).converse(REQUEST)).toEqual({ stopReason: 'max_tokens', content: [] });
    const incomplete = fakeFetch(() => sse([{ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }]));
    expect(await new ChatGPTPlanModel(OPTIONS, tokens, incomplete.impl).converse(REQUEST)).toEqual({ stopReason: 'max_tokens', content: [] });
  });

  it('says when the plan is out of usage or not eligible, before or during the stream', async () => {
    const limit = { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } };
    const before = fakeFetch(() => new Response(JSON.stringify(limit), { status: 429 }));
    await expect(new ChatGPTPlanModel(OPTIONS, tokens, before.impl).converse(REQUEST)).rejects.toMatchObject({ name: 'ModelUnavailableError', reason: 'usage_limit' });
    const during = fakeFetch(() => sse([{ type: 'response.output_text.delta', delta: 'Su' }, { type: 'response.failed', response: limit }]));
    await expect(new ChatGPTPlanModel(OPTIONS, tokens, during.impl).converse(REQUEST)).rejects.toMatchObject({ reason: 'usage_limit' });
    const eligible = fakeFetch(() => new Response(JSON.stringify({ error: { code: 'subscription_sharing_user_not_eligible' } }), { status: 403 }));
    await expect(new ChatGPTPlanModel(OPTIONS, tokens, eligible.impl).converse(REQUEST)).rejects.toMatchObject({ reason: 'not_eligible' });
    const rejected = fakeFetch(() => new Response('{}', { status: 401 }));
    await expect(new ChatGPTPlanModel(OPTIONS, tokens, rejected.impl).converse(REQUEST)).rejects.toBeInstanceOf(ModelUnavailableError);
  });

  it('retries a temporary 503 a bounded number of times, and nothing else', async () => {
    const unavailable = () => new Response(JSON.stringify({ error: { code: 'subscription_sharing_usage_unavailable' } }), { status: 503 });
    const ok = () => sse([completed([{ type: 'message', content: [{ type: 'output_text', text: 'Back.' }] }])]);
    const recovers = fakeFetch(unavailable, unavailable, ok);
    expect((await new ChatGPTPlanModel(OPTIONS, tokens, recovers.impl).converse(REQUEST)).content).toEqual([{ text: 'Back.' }]);
    expect(recovers.calls).toHaveLength(3);

    const stays = fakeFetch(unavailable, unavailable, unavailable);
    await expect(new ChatGPTPlanModel(OPTIONS, tokens, stays.impl).converse(REQUEST)).rejects.toThrow(/503 subscription_sharing_usage_unavailable/);
    expect(stays.calls).toHaveLength(3);

    const bad = fakeFetch(() => new Response('{"error":{"code":"subscription_sharing_unsupported_capability"}}', { status: 400 }));
    await expect(new ChatGPTPlanModel(OPTIONS, tokens, bad.impl).converse(REQUEST)).rejects.toThrow(/400 subscription_sharing_unsupported_capability/);
    expect(bad.calls).toHaveLength(1);
  });

  it('fails a stream that ends or breaks before the response completes', async () => {
    const cut = fakeFetch(() => sse([{ type: 'response.output_text.delta', delta: 'Hi' }]));
    await expect(new ChatGPTPlanModel(OPTIONS, tokens, cut.impl).converse(REQUEST)).rejects.toThrow(/ended before the response completed/);
    const reset = fakeFetch(() => sse([{ type: 'response.output_text.delta', delta: 'Hi' }], { end: false }));
    await expect(new ChatGPTPlanModel(OPTIONS, tokens, reset.impl).converse(REQUEST)).rejects.toThrow(/connection reset/);
    const error = fakeFetch(() => sse([{ type: 'error', code: 'server_error', message: 'boom' }]));
    await expect(new ChatGPTPlanModel(OPTIONS, tokens, error.impl).converse(REQUEST)).rejects.toThrow(/server_error/);
  });
});
