// Voice windows (IMPLEMENTATION_PLAN §2.2, §8.5): short windows in which a bare phrase answers what was just asked.
import type { Queryable } from '../db.ts';
import type { OutboundMessage } from './outbound.ts';

export const WINDOW_MS = 30_000;

export type VoiceWindow =
  | { id: string; kind: 'proposal_confirm'; proposal_id: string; version: number; source_message_id: number }
  | {
      id: string;
      kind: 'timer_offer';
      timer_spec: { label: string; seconds: number; session_id: string; step_no: number };
      source_message_id: number;
    };

const SELECT_WINDOW = `SELECT id, kind, proposal_id, version, timer_spec, source_message_id::int FROM agent.voice_windows`;

const toWindow = (r: Record<string, unknown>): VoiceWindow =>
  r.kind === 'proposal_confirm'
    ? { id: r.id as string, kind: 'proposal_confirm', proposal_id: r.proposal_id as string, version: r.version as number, source_message_id: r.source_message_id as number }
    : { id: r.id as string, kind: 'timer_offer', timer_spec: r.timer_spec as never, source_message_id: r.source_message_id as number };

/**
 * Opens the window for a message's stored prompt, closing any other open window (§8.5). A repeated
 * ack of the same message returns the window it opened, without extending it (VC13).
 */
export async function openWindow(q: Queryable, message: OutboundMessage, windowMs = WINDOW_MS): Promise<{ id: string; window_ends_at: Date }> {
  const existing = await q.query<{ id: string; window_ends_at: Date }>(
    `SELECT id, window_ends_at FROM agent.voice_windows WHERE conversation_id = $1 AND source_message_id = $2`,
    [message.conversation_id, message.id],
  );
  if (existing.rows[0]) return existing.rows[0];
  const prompt = message.voice_prompt!;
  await q.query(`UPDATE agent.voice_windows SET status = 'closed' WHERE conversation_id = $1 AND status = 'open'`, [message.conversation_id]);
  const { rows } = await q.query<{ id: string; window_ends_at: Date }>(
    `INSERT INTO agent.voice_windows (id, conversation_id, kind, source_message_id, proposal_id, version, timer_spec, window_ends_at, status)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7::float / 1000), 'open')
     RETURNING id, window_ends_at`,
    [
      message.conversation_id,
      prompt.kind,
      message.id,
      prompt.kind === 'proposal_confirm' ? prompt.proposal_id : null,
      prompt.kind === 'proposal_confirm' ? prompt.version : null,
      prompt.kind === 'timer_offer'
        ? JSON.stringify({ label: prompt.label, seconds: prompt.seconds, session_id: prompt.session_id, step_no: prompt.step_no })
        : null,
      windowMs,
    ],
  );
  return rows[0]!;
}

/**
 * The conversation's open window that has not run out (§8.5 step 2). Read under the conversation
 * lease, which serializes the gate with every other turn.
 */
export async function openWindowFor(q: Queryable, conversationId: string): Promise<VoiceWindow | null> {
  const { rows } = await q.query(`${SELECT_WINDOW} WHERE conversation_id = $1 AND status = 'open' AND window_ends_at > now()`, [
    conversationId,
  ]);
  return rows[0] ? toWindow(rows[0]) : null;
}

export async function consumeWindow(q: Queryable, id: string): Promise<void> {
  await q.query(`UPDATE agent.voice_windows SET status = 'consumed' WHERE id = $1`, [id]);
}

/** A new prompt supersedes whatever was asked before (§8.5: a card read-back cancels a timer offer). */
export async function closeOpenWindows(q: Queryable, conversationId: string): Promise<void> {
  await q.query(`UPDATE agent.voice_windows SET status = 'closed' WHERE conversation_id = $1 AND status = 'open'`, [conversationId]);
}
