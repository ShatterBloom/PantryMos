// What Mos says and shows, polled by the web app (IMPLEMENTATION_PLAN §2.2, §8.6 Delivery).
import type { Queryable } from '../db.ts';

/** What a message asked, so an ack can open the matching voice window (§8.5). */
export type VoicePrompt =
  | { kind: 'proposal_confirm'; proposal_id: string; version: number }
  | { kind: 'timer_offer'; label: string; seconds: number; session_id: string; step_no: number };

export interface Card {
  type: 'proposal' | 'step' | 'options';
  [key: string]: unknown;
}

export interface NewOutbound {
  conversationId: string;
  turnType: 'user' | 'proactive' | 'gate';
  speech: string;
  cards?: Card[];
  voicePrompt?: VoicePrompt | null;
  /** The step this message delivered, the source of the next turn's `expected_step` (§7.4). */
  step?: { session_id: string; step_no: number } | null;
}

export interface OutboundMessage {
  id: number;
  conversation_id: string;
  turn_type: NewOutbound['turnType'];
  speech: string;
  cards: Card[];
  voice_prompt: VoicePrompt | null;
  session_id: string | null;
  step_no: number | null;
  created_at: Date;
}

const SELECT_OUTBOUND = `
  SELECT id::int, conversation_id, turn_type, speech, cards, voice_prompt, session_id, step_no, created_at
    FROM agent.outbound_messages`;

export async function insertOutbound(q: Queryable, m: NewOutbound): Promise<number> {
  const { rows } = await q.query<{ id: number }>(
    `INSERT INTO agent.outbound_messages (conversation_id, turn_type, speech, cards, voice_prompt, session_id, step_no)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id::int`,
    [
      m.conversationId,
      m.turnType,
      m.speech,
      JSON.stringify(m.cards ?? []),
      m.voicePrompt ? JSON.stringify(m.voicePrompt) : null,
      m.step?.session_id ?? null,
      m.step?.step_no ?? null,
    ],
  );
  return rows[0]!.id;
}

export async function listOutbound(q: Queryable, conversationId: string, afterId = 0): Promise<OutboundMessage[]> {
  const { rows } = await q.query<OutboundMessage>(`${SELECT_OUTBOUND} WHERE conversation_id = $1 AND id > $2 ORDER BY id`, [
    conversationId,
    afterId,
  ]);
  return rows;
}

export async function outboundById(q: Queryable, conversationId: string, id: number): Promise<OutboundMessage | null> {
  const { rows } = await q.query<OutboundMessage>(`${SELECT_OUTBOUND} WHERE conversation_id = $1 AND id = $2`, [conversationId, id]);
  return rows[0] ?? null;
}

/** The step the user last heard: the latest message that delivered one (§7.4 `expected_step`). */
export async function lastDeliveredStep(q: Queryable, conversationId: string): Promise<{ session_id: string; step_no: number } | null> {
  const { rows } = await q.query<{ session_id: string; step_no: number }>(
    `SELECT session_id, step_no FROM agent.outbound_messages
      WHERE conversation_id = $1 AND session_id IS NOT NULL ORDER BY id DESC LIMIT 1`,
    [conversationId],
  );
  return rows[0] ?? null;
}

/** The latest card read back in this conversation, whatever its fate since (§8.5 step 6). */
export async function lastReadBackProposal(q: Queryable, conversationId: string): Promise<string | null> {
  const { rows } = await q.query<{ proposal_id: string }>(
    `SELECT voice_prompt ->> 'proposal_id' AS proposal_id FROM agent.outbound_messages
      WHERE conversation_id = $1 AND voice_prompt ->> 'kind' = 'proposal_confirm' ORDER BY id DESC LIMIT 1`,
    [conversationId],
  );
  return rows[0]?.proposal_id ?? null;
}
