// Shared plumbing for tool handlers: result shapes (§7.1) and request metadata (§5.1).
import { randomUUID } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { type BusinessError, META_CONVERSATION_ID, META_REQUEST_ID } from '@pantrymos/shared';
import { z } from 'zod';
import { runIdempotent } from '../db/requestLog.ts';
import type { Tx } from '../db/tx.ts';
import { PantryError } from '../domain/errors.ts';
import type { ToolContext } from './context.ts';

/** Conversation used for writes from clients without `_meta`, only when ALLOW_ANON_WRITES=1. */
export const INSPECTOR_CONVERSATION_ID = '00000000-0000-4000-8000-00000000c0de';

const Uuid = z.uuid();

export function successResult(data: Record<string, unknown>, text: string): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: data };
}

/**
 * Business error (§7.1): a sentence for people, then the full error body as JSON for models and
 * programs. No `structuredContent`: SDK clients (1.32.1) validate it against the tool's success
 * outputSchema even when `isError` is set, which would turn every business error into a protocol error.
 */
export function errorResult(error: BusinessError): CallToolResult {
  const text = error.ask ? `${error.message} ${error.ask}` : error.message;
  return {
    isError: true,
    content: [
      { type: 'text', text },
      { type: 'text', text: JSON.stringify(error) },
    ],
  };
}

/** Reads the error body back out of an `errorResult` (for the agent and tests). */
export function parseErrorResult(result: object): BusinessError | null {
  const { isError, content } = result as { isError?: unknown; content?: unknown };
  if (isError !== true || !Array.isArray(content)) return null;
  const json = (content as Array<{ type?: string; text?: string }>)[1];
  if (json?.type !== 'text' || json.text === undefined) return null;
  try {
    return JSON.parse(json.text) as BusinessError;
  } catch {
    return null;
  }
}

export interface RequestMeta {
  requestId: string;
  conversationId: string | null;
}

/**
 * Reads `pantrymos/request_id` and `pantrymos/conversation_id` from the call's `_meta`.
 * They are never tool arguments, so the model cannot see or forge them through the schema.
 */
export function readRequestMeta(
  meta: Record<string, unknown> | undefined,
  options: { needsConversation: boolean; allowAnonWrites: boolean },
): RequestMeta {
  const rawRequestId = meta?.[META_REQUEST_ID];
  let requestId: string;
  if (rawRequestId === undefined && options.allowAnonWrites) {
    requestId = randomUUID();
  } else if (Uuid.safeParse(rawRequestId).success) {
    requestId = rawRequestId as string;
  } else {
    throw new PantryError('request_id_required', `This tool needs _meta["${META_REQUEST_ID}"] set to a UUID.`);
  }

  const rawConversationId = meta?.[META_CONVERSATION_ID];
  let conversationId: string | null = null;
  if (Uuid.safeParse(rawConversationId).success) {
    conversationId = rawConversationId as string;
  } else if (options.needsConversation) {
    if (rawConversationId === undefined && options.allowAnonWrites) {
      conversationId = INSPECTOR_CONVERSATION_ID;
    } else {
      throw new PantryError(
        'conversation_id_required',
        `This tool needs _meta["${META_CONVERSATION_ID}"] set to a UUID.`,
      );
    }
  }
  return { requestId, conversationId };
}

export interface ToolSuccess {
  data: Record<string, unknown>;
  text: string;
}

/** Read tools: business errors become `isError` results; anything else is a fault. */
export async function runReadTool(fn: () => Promise<ToolSuccess>): Promise<CallToolResult> {
  try {
    const { data, text } = await fn();
    return successResult(data, text);
  } catch (err) {
    if (err instanceof PantryError) return errorResult(err.toBody());
    throw err;
  }
}

/**
 * Write tools: resolves request metadata, then runs `effect` once per request_id inside the
 * request-log transaction. A retry returns the stored result, success or business error.
 */
export async function runWriteTool(
  ctx: ToolContext,
  call: { name: string; args: unknown; meta: Record<string, unknown> | undefined; needsConversation: boolean },
  effect: (tx: Tx, meta: RequestMeta) => Promise<ToolSuccess>,
): Promise<CallToolResult> {
  let meta: RequestMeta;
  try {
    meta = readRequestMeta(call.meta, {
      needsConversation: call.needsConversation,
      allowAnonWrites: ctx.config.allowAnonWrites,
    });
  } catch (err) {
    if (err instanceof PantryError) return errorResult(err.toBody());
    throw err;
  }

  const outcome = await runIdempotent(
    ctx.pool,
    {
      householdId: ctx.auth.householdId,
      requestId: meta.requestId,
      scope: `tool:${call.name}`,
      payload: { args: call.args, conversation_id: meta.conversationId },
    },
    async (tx) => ({ status: 200, body: await effect(tx, meta) }),
  );
  if (outcome.status !== 200) return errorResult(outcome.body as BusinessError);
  const { data, text } = outcome.body as ToolSuccess;
  return successResult(data, text);
}
