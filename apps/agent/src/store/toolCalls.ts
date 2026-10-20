// Write-ahead record of every tool call (IMPLEMENTATION_PLAN §5.2, §8.2): the final input is stored before
// the call runs, so a resumed turn re-sends exactly that input under the same request_id.
import type { Queryable } from '../db.ts';

/** A tool's result as the model and the cards see it. */
export interface ToolOutput {
  isError: boolean;
  /** structuredContent: the success output, or the business error `{code, message, ...}`. */
  data: Record<string, unknown>;
  text: string;
}

export interface ToolCallRow {
  tool_use_id: string;
  name: string;
  final_input: Record<string, unknown>;
  request_id: string;
  status: 'pending' | 'done';
  result: ToolOutput | null;
}

/** Owner of a turn's calls: the chat request (user turns) or the app events (proactive turns). */
export type TurnOwner = { chatRequestId: string } | { eventIds: string[] };

export async function insertPending(
  q: Queryable,
  conversationId: string,
  owner: TurnOwner,
  call: { toolUseId: string; name: string; finalInput: Record<string, unknown>; requestId: string },
): Promise<void> {
  await q.query(
    `INSERT INTO agent.tool_calls (conversation_id, tool_use_id, chat_request_id, event_ids, name, final_input, request_id, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', clock_timestamp())
     ON CONFLICT (conversation_id, tool_use_id) DO NOTHING`,
    [
      conversationId,
      call.toolUseId,
      'chatRequestId' in owner ? owner.chatRequestId : null,
      'eventIds' in owner ? owner.eventIds : null,
      call.name,
      JSON.stringify(call.finalInput),
      call.requestId,
    ],
  );
}

export async function markDone(q: Queryable, conversationId: string, toolUseId: string, result: ToolOutput): Promise<void> {
  await q.query(`UPDATE agent.tool_calls SET status = 'done', result = $3 WHERE conversation_id = $1 AND tool_use_id = $2`, [
    conversationId,
    toolUseId,
    JSON.stringify(result),
  ]);
}

export async function callsByToolUse(q: Queryable, conversationId: string, toolUseIds: readonly string[]): Promise<Map<string, ToolCallRow>> {
  const { rows } = await q.query<ToolCallRow>(
    `SELECT tool_use_id, name, final_input, request_id, status, result FROM agent.tool_calls
      WHERE conversation_id = $1 AND tool_use_id = ANY ($2::text[])`,
    [conversationId, toolUseIds],
  );
  return new Map(rows.map((r) => [r.tool_use_id, r]));
}

/** Every call of one turn, in the order they were made. */
export async function callsOfTurn(q: Queryable, conversationId: string, owner: TurnOwner): Promise<ToolCallRow[]> {
  const { rows } = await q.query<ToolCallRow>(
    `SELECT tool_use_id, name, final_input, request_id, status, result FROM agent.tool_calls
      WHERE conversation_id = $1
        AND ${'chatRequestId' in owner ? 'chat_request_id = $2' : 'event_ids && $2::uuid[]'}
      ORDER BY created_at, tool_use_id`,
    [conversationId, 'chatRequestId' in owner ? owner.chatRequestId : owner.eventIds],
  );
  return rows;
}
