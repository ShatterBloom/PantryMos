// Any OpenAI-compatible Chat Completions endpoint: OpenAI, or a local server such as Ollama, LM Studio
// or vLLM (their `/v1` API). The turn loop keeps the Bedrock Converse shape; this maps it both ways.
import { randomUUID } from 'node:crypto';
import type { ContentBlock, Message, ModelClient, ModelRequest, ModelResponse, ToolResult } from './types.ts';

export interface OpenAIOptions {
  /** The API root, ending before `/chat/completions`, e.g. `https://api.openai.com/v1`. */
  baseUrl: string;
  /** Sent as a bearer token; local servers usually need none. */
  apiKey?: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
}

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }>;
  max_tokens: number;
  temperature: 0;
}

/** The part of a Chat Completions response this reads. */
export interface ChatResponse {
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** What the turn loop sends, in the Chat Completions shape. Exported for tests. */
export function toChatRequest(request: ModelRequest, options: Pick<OpenAIOptions, 'model' | 'maxTokens'>): ChatRequest {
  const tools = request.tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: withoutUnicodePatterns(t.inputSchema) as Record<string, unknown> },
  }));
  return {
    model: options.model,
    messages: [{ role: 'system', content: request.system }, ...request.messages.flatMap(toChatMessages)],
    ...(tools.length > 0 ? { tools } : {}),
    max_tokens: options.maxTokens,
    temperature: 0,
  };
}

/**
 * OpenAI refuses a whole request whose tool schemas hold a `pattern` with a Unicode property escape
 * (the MCP tools' `^[^\p{Cc}]*$`: "is not a 'regex'"). Such patterns are left out of what the model
 * sees; the MCP server still checks every input against its own schema.
 */
function withoutUnicodePatterns(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withoutUnicodePatterns);
  if (typeof schema !== 'object' || schema === null) return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key, value]) => !(key === 'pattern' && typeof value === 'string' && /\\[pP]\{/.test(value)))
      .map(([key, value]) => [key, withoutUnicodePatterns(value)]),
  );
}

/**
 * One Converse message can become several chat messages: tool results are `tool` messages of their
 * own, and they must come straight after the assistant message that asked for them.
 */
function toChatMessages(message: Message): ChatMessage[] {
  const text = message.content.flatMap((b) => ('text' in b ? [b.text] : [])).join('\n');
  if (message.role === 'assistant') {
    const calls = message.content.flatMap((b): ChatToolCall[] =>
      'toolUse' in b
        ? [{ id: b.toolUse.toolUseId, type: 'function', function: { name: b.toolUse.name, arguments: JSON.stringify(b.toolUse.input ?? {}) } }]
        : [],
    );
    // Content may be null only beside tool calls; an empty reply in history stays an empty string.
    return [calls.length > 0 ? { role: 'assistant', content: text === '' ? null : text, tool_calls: calls } : { role: 'assistant', content: text }];
  }
  const results = message.content.flatMap((b): ChatMessage[] =>
    'toolResult' in b ? [{ role: 'tool', tool_call_id: b.toolResult.toolUseId, content: toolResultText(b.toolResult) }] : [],
  );
  return text === '' ? results : [...results, { role: 'user', content: text }];
}

/** Chat Completions has no error flag on a tool result, so an error says so in its text. */
function toolResultText(result: ToolResult): string {
  const body = result.content.map((c) => ('json' in c ? JSON.stringify(c.json) : c.text)).join('\n');
  return result.status === 'error' ? `Error: ${body}` : body;
}

/**
 * Reasoning models served through these APIs (DeepSeek R1, Qwen and others on Ollama) write their
 * chain of thought as `<think>…</think>`; Nova's `<thinking>` form is caught too. Left in, it would be
 * spoken. A block cut off by the token cap has no closing tag, so it runs to the end of the text.
 */
const THINKING = /<think(?:ing)?>[\s\S]*?(?:<\/think(?:ing)?>|$)/g;

const STOP_REASONS: Record<string, string> = { tool_calls: 'tool_use', stop: 'end_turn', length: 'max_tokens' };

/**
 * The model's reply in the turn loop's shape. As with Bedrock, a reply cut off by the token cap, or
 * with tool arguments that are not a JSON object, is dropped whole; it comes back empty and the turn
 * loop asks again.
 */
export function fromChatResponse(body: ChatResponse): ModelResponse {
  const choice = body.choices?.[0];
  const finish = choice?.finish_reason ?? 'stop';
  let stopReason = STOP_REASONS[finish] ?? finish;
  let content: ContentBlock[] = [];
  const text = (choice?.message?.content ?? '').replace(THINKING, '').trim();
  if (text !== '') content.push({ text });
  for (const call of choice?.message?.tool_calls ?? []) {
    const input = parseArguments(call.function?.arguments);
    if (input === undefined || !call.function?.name) {
      stopReason = 'malformed_tool_use';
      break;
    }
    content.push({ toolUse: { toolUseId: call.id || randomUUID(), name: call.function.name, input } });
  }
  if (stopReason === 'max_tokens' || stopReason.startsWith('malformed_')) content = [];
  const response: ModelResponse = { stopReason, content };
  if (body.usage) response.usage = { inputTokens: body.usage.prompt_tokens ?? 0, outputTokens: body.usage.completion_tokens ?? 0 };
  return response;
}

/** A tool call's arguments as an object; an empty string means none. */
function parseArguments(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined || raw.trim() === '') return {};
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export class OpenAICompatibleModel implements ModelClient {
  private readonly options: OpenAIOptions;
  private readonly fetch: typeof fetch;

  constructor(options: OpenAIOptions, fetchImpl: typeof fetch = fetch) {
    this.options = options;
    this.fetch = fetchImpl;
  }

  async converse(request: ModelRequest): Promise<ModelResponse> {
    const url = `${this.options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const response = await this.fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
      },
      body: JSON.stringify(toChatRequest(request, this.options)),
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    if (!response.ok) {
      // The body names the problem (unknown model, bad key); it never echoes the key.
      throw new Error(`Chat Completions request failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
    }
    return fromChatResponse((await response.json()) as ChatResponse);
  }
}
