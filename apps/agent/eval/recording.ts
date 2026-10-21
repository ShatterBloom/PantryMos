// Wraps the real model so a case can see every exchange: tool calls, their results, and timing.
import { isToolResult, isToolUse, type ModelClient, type ModelRequest, type ModelResponse } from '../src/model/types.ts';
import type { ToolCall } from './checks.ts';

export interface Exchange {
  request: ModelRequest;
  response: ModelResponse;
  ms: number;
}

export class RecordingModel implements ModelClient {
  readonly exchanges: Exchange[] = [];
  private readonly inner: ModelClient;

  constructor(inner: ModelClient) {
    this.inner = inner;
  }

  async converse(request: ModelRequest): Promise<ModelResponse> {
    const started = performance.now();
    const response = await this.inner.converse(request);
    this.exchanges.push({ request: structuredClone(request), response, ms: performance.now() - started });
    return response;
  }
}

/**
 * The tool calls the model made, in order, each with the status of its result. A result is in a
 * later request's messages, matched by toolUseId; a call whose turn ended first has none.
 */
export function toolCalls(exchanges: readonly Exchange[]): ToolCall[] {
  const status = new Map<string, 'success' | 'error'>();
  for (const { request } of exchanges) {
    for (const m of request.messages) for (const b of m.content) if (isToolResult(b)) status.set(b.toolResult.toolUseId, b.toolResult.status);
  }
  return exchanges.flatMap(({ response }) =>
    response.content.filter(isToolUse).map(({ toolUse }) => ({
      name: toolUse.name,
      input: (toolUse.input ?? {}) as Record<string, unknown>,
      status: status.get(toolUse.toolUseId) ?? null,
    })),
  );
}
