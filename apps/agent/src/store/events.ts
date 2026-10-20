// App events: outcomes fed back to the model, and the triggers of proactive turns (IMPLEMENTATION_PLAN §2.2, §8.6).
import type { Queryable } from '../db.ts';

export type EventKind = 'timer_fired' | 'proposal_committed' | 'proposal_stale' | 'proposal_rejected' | 'window_expired';

export interface AppEvent {
  id: string;
  conversation_id: string;
  kind: EventKind;
  payload: Record<string, unknown>;
  created_at: Date;
}

export interface NewEvent {
  conversationId: string;
  kind: EventKind;
  payload: Record<string, unknown>;
  /** §5.2: e.g. `proposal:<id>:v<version>:<outcome>`; a repeat is ignored. */
  dedupeKey: string;
  /** True → the event worker runs a proactive turn for it; false → the next user turn sees it. */
  triggersTurn: boolean;
}

export async function insertEvent(q: Queryable, e: NewEvent): Promise<void> {
  await q.query(
    `INSERT INTO agent.app_events (id, conversation_id, kind, payload, dedupe_key, triggers_turn)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
     ON CONFLICT (conversation_id, dedupe_key) DO NOTHING`,
    [e.conversationId, e.kind, JSON.stringify(e.payload), e.dedupeKey, e.triggersTurn],
  );
}

/**
 * Events a user turn feeds to the model, marked delivered: everything not yet delivered except
 * events still waiting for their own proactive turn (§8.1 queueing).
 */
export async function drainForUserTurn(q: Queryable, conversationId: string): Promise<AppEvent[]> {
  const { rows } = await q.query<AppEvent>(
    `UPDATE agent.app_events SET delivered_at = now()
      WHERE conversation_id = $1 AND delivered_at IS NULL
        AND (NOT triggers_turn OR turn_done_at IS NOT NULL OR turn_failed)
      RETURNING id, conversation_id, kind, payload, created_at`,
    [conversationId],
  );
  return rows.sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id));
}

export async function markDelivered(q: Queryable, ids: readonly string[]): Promise<void> {
  await q.query(`UPDATE agent.app_events SET delivered_at = COALESCE(delivered_at, now()) WHERE id = ANY ($1::uuid[])`, [ids]);
}
