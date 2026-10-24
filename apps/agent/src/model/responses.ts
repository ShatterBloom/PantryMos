// A ChatGPT plan's models, through "Sign in with ChatGPT" and the public Responses API. The preview
// route's rules (developers.openai.com/siwc, "Preview limitations"): `store: false` and `stream: true`
// on every request, the whole history in `input`, the system prompt as `instructions`, and no
// `temperature` or `max_output_tokens`, so the reply's length is capped here while it streams.
import { randomUUID } from 'node:crypto';
import { withoutUnicodePatterns } from './toolSchema.ts';
import { type ContentBlock, type Message, type ModelClient, type ModelRequest, type ModelResponse, ModelUnavailableError, type ToolResult } from './types.ts';

/** The signed-in plan: a current access token (refreshed when about to expire) and its default model. */
export interface PlanCredentials {
  current(): Promise<{ accessToken: string; model: string | null }>;
}

export interface ResponsesOptions {
  /** The API root, `https://api.openai.com/v1`. */
  apiUrl: string;
  /** Unset: the plan's default, the first model its catalog lists. */
  model?: string;
  /** The reply cap, in tokens; counted as 4 characters each while the reply streams. */
  maxTokens: number;
  timeoutMs: number;
  /** Waits before each retry of a temporary failure (a 503); one retry per entry. */
  retryDelaysMs?: readonly number[];
}

type InputItem =
  | { role: 'user' | 'assistant'; content: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

export interface ResponsesRequest {
  model: string;
  instructions: string;
  input: InputItem[];
  tools?: Array<{ type: 'function'; name: string; description: string; parameters: Record<string, unknown>; strict: false }>;
  store: false;
  stream: true;
}

/** An output item of a finished response, as far as this reads it. */
export interface OutputItem {
  type?: string;
  content?: Array<{ type?: string; text?: string }>;
  call_id?: string;
  name?: string;
  arguments?: string;
}

/** What the turn loop sends, in the Responses shape. Exported for tests. */
export function toResponsesRequest(request: ModelRequest, model: string): ResponsesRequest {
  const tools = request.tools.map((t) => ({
    type: 'function' as const,
    name: t.name,
    description: t.description,
    parameters: withoutUnicodePatterns(t.inputSchema) as Record<string, unknown>,
    strict: false as const,
  }));
  return {
    model,
    instructions: request.system,
    input: request.messages.flatMap(toInputItems),
    ...(tools.length > 0 ? { tools } : {}),
    store: false,
    stream: true,
  };
}

/** Tool results come first, as in the Chat Completions mapping; an empty reply in history is left out. */
function toInputItems(message: Message): InputItem[] {
  const text = message.content.flatMap((b) => ('text' in b ? [b.text] : [])).join('\n');
  const items: InputItem[] = [];
  for (const block of message.content) {
    if ('toolUse' in block) {
      items.push({ type: 'function_call', call_id: block.toolUse.toolUseId, name: block.toolUse.name, arguments: JSON.stringify(block.toolUse.input ?? {}) });
    } else if ('toolResult' in block) {
      items.push({ type: 'function_call_output', call_id: block.toolResult.toolUseId, output: toolResultText(block.toolResult) });
    }
  }
  if (text === '') return items;
  // An assistant's words come before the calls it made; a user's after the results they answer.
  return message.role === 'assistant' ? [{ role: 'assistant', content: text }, ...items] : [...items, { role: 'user', content: text }];
}

/** Responses has no error flag on a tool result, so an error says so in its text. */
function toolResultText(result: ToolResult): string {
  const body = result.content.map((c) => ('json' in c ? JSON.stringify(c.json) : c.text)).join('\n');
  return result.status === 'error' ? `Error: ${body}` : body;
}

/** Reasoning written into the text (`<think>` or `<thinking>`), as in the other adapters. */
const THINKING = /<think(?:ing)?>[\s\S]*?(?:<\/think(?:ing)?>|$)/g;

/**
 * A finished response's output in the turn loop's shape: message text and function calls; reasoning
 * items are dropped. Tool arguments that are not a JSON object drop the reply whole, so the turn loop
 * asks again.
 */
export function fromResponsesOutput(output: readonly OutputItem[], usage?: { input_tokens?: number; output_tokens?: number }): ModelResponse {
  const content: ContentBlock[] = [];
  let calls = 0;
  for (const item of output) {
    if (item.type === 'message') {
      const text = (item.content ?? [])
        .flatMap((c) => (c.type === 'output_text' && c.text ? [c.text] : []))
        .join('')
        .replace(THINKING, '')
        .trim();
      if (text !== '') content.push({ text });
    } else if (item.type === 'function_call') {
      const input = parseArguments(item.arguments);
      if (input === undefined || !item.name) return withUsage({ stopReason: 'malformed_tool_use', content: [] }, usage);
      content.push({ toolUse: { toolUseId: item.call_id || randomUUID(), name: item.name, input } });
      calls++;
    }
  }
  return withUsage({ stopReason: calls > 0 ? 'tool_use' : 'end_turn', content }, usage);
}

function withUsage(response: ModelResponse, usage: { input_tokens?: number; output_tokens?: number } | undefined): ModelResponse {
  if (usage) response.usage = { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 };
  return response;
}

function parseArguments(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined || raw.trim() === '') return {};
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Plan-usage errors ("Errors and recovery"): each stops the request; none switches to other billing. */
const UNAVAILABLE: Record<string, [ModelUnavailableError['reason'], string]> = {
  subscription_sharing_usage_limit_exceeded: ['usage_limit', 'The ChatGPT plan has reached its usage limit for this app.'],
  subscription_sharing_user_not_eligible: ['not_eligible', "This ChatGPT account's plan can't be used in other apps."],
};
/** Temporary: retried a few times with a pause. */
const RETRYABLE = new Set(['subscription_sharing_usage_unavailable', 'subscription_sharing_user_unavailable']);

const errorCode = (body: unknown): string | undefined => {
  const b = body as { code?: unknown; error?: { code?: unknown } } | null;
  const code = b?.error?.code ?? b?.code;
  return typeof code === 'string' ? code : undefined;
};

/** The error a failed request or stream event stands for. */
function failure(status: number | null, body: unknown, raw: string): Error {
  const code = errorCode(body);
  const known = code ? UNAVAILABLE[code] : undefined;
  if (known) return new ModelUnavailableError(known[0], known[1]);
  if (status === 401) return new ModelUnavailableError('signed_out', 'ChatGPT did not accept the sign-in. Sign in with ChatGPT again.');
  return new Error(`Responses request failed: ${status ?? 'stream'} ${code ?? ''} ${raw.slice(0, 300)}`.trim());
}

class Retry extends Error {}

/** One server-sent event's JSON payload at a time. */
async function* events(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  let buffer = '';
  for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    let end: number;
    while ((end = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, '');
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data !== '' && data !== '[DONE]') yield JSON.parse(data) as Record<string, unknown>;
    }
  }
}

export class ChatGPTPlanModel implements ModelClient {
  private readonly options: ResponsesOptions;
  private readonly credentials: PlanCredentials;
  private readonly fetch: typeof fetch;

  constructor(options: ResponsesOptions, credentials: PlanCredentials, fetchImpl: typeof fetch = fetch) {
    this.options = options;
    this.credentials = credentials;
    this.fetch = fetchImpl;
  }

  async converse(request: ModelRequest): Promise<ModelResponse> {
    const delays = this.options.retryDelaysMs ?? [500, 1500];
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(request);
      } catch (err) {
        if (!(err instanceof Retry) || attempt >= delays.length) throw err instanceof Retry ? new Error(err.message) : err;
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      }
    }
  }

  private async once(request: ModelRequest): Promise<ModelResponse> {
    const { accessToken, model } = await this.credentials.current();
    const slug = this.options.model ?? model;
    if (!slug) throw new ModelUnavailableError('not_eligible', 'The ChatGPT plan lists no model this app can use.');
    const body = JSON.stringify(toResponsesRequest(request, slug));
    const abort = new AbortController();
    const response = await this.fetch(`${this.options.apiUrl.replace(/\/+$/, '')}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body,
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(this.options.timeoutMs)]),
    });
    if (!response.ok || !response.body) {
      const raw = await response.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // not JSON: reported as text
      }
      const code = errorCode(parsed);
      if (response.status === 503 && (!code || RETRYABLE.has(code))) throw new Retry(`Responses request failed: 503 ${code ?? ''} ${raw.slice(0, 300)}`);
      throw failure(response.status, parsed, raw);
    }

    const cap = this.options.maxTokens * 4;
    let streamed = 0;
    // ChatGPT's backend sends each finished item on its own and leaves the completed response's
    // output empty (store: false); the API may send both.
    const items: OutputItem[] = [];
    try {
      for await (const event of events(response.body)) {
        switch (event.type) {
          case 'response.output_text.delta':
          case 'response.function_call_arguments.delta':
            streamed += typeof event.delta === 'string' ? event.delta.length : 0;
            // Nothing meant to be said aloud runs this long (the other adapters' token cap).
            if (streamed > cap) return { stopReason: 'max_tokens', content: [] };
            break;
          case 'response.output_item.done':
            if (event.item) items.push(event.item as OutputItem);
            break;
          case 'response.completed': {
            const done = event.response as { output?: OutputItem[]; usage?: { input_tokens?: number; output_tokens?: number } } | undefined;
            return fromResponsesOutput(done?.output?.length ? done.output : items, done?.usage);
          }
          case 'response.incomplete':
            // Cut off by the server: dropped, as a reply cut off by a token cap is.
            return { stopReason: 'max_tokens', content: [] };
          case 'response.failed': {
            const error = (event.response as { error?: unknown } | undefined)?.error;
            throw failure(null, { error }, JSON.stringify(error ?? {}));
          }
          case 'error':
            throw failure(null, event, JSON.stringify(event));
        }
      }
    } finally {
      abort.abort();
    }
    throw new Error('Responses stream ended before the response completed');
  }
}
