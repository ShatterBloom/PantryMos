// Cooking timers (IMPLEMENTATION_PLAN §2.2, §8.6). Every state change is a conditional UPDATE, so
// concurrent or repeated requests cannot apply twice.
import type { Queryable } from '../db.ts';

export type TimerStatus = 'running' | 'paused' | 'fired' | 'cancelled';

export interface Timer {
  id: string;
  label: string;
  seconds: number;
  status: TimerStatus;
  /** Seconds left for a running or paused timer, else null. */
  remaining_seconds: number | null;
  session_id: string | null;
  step_no: number | null;
}

export interface NewTimer {
  conversationId: string;
  requestId: string;
  label: string;
  seconds: number;
  sessionId?: string | null;
  stepNo?: number | null;
}

const SELECT_TIMER = `
  SELECT id, label, seconds, status, session_id, step_no,
         CASE status WHEN 'running' THEN GREATEST(0, ceil(extract(epoch FROM fires_at - now())))::int
                     WHEN 'paused' THEN remaining_s END AS remaining_seconds
    FROM agent.timers`;

/** Starts a timer once per request_id (§5.2): a repeat returns the timer the first call started. */
export async function startTimer(q: Queryable, t: NewTimer): Promise<Timer> {
  await q.query(
    `INSERT INTO agent.timers (id, conversation_id, session_id, step_no, label, seconds, status, fires_at, request_id)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::int, 'running', now() + make_interval(secs => $5::int), $6)
     ON CONFLICT (conversation_id, request_id) DO NOTHING`,
    [t.conversationId, t.sessionId ?? null, t.stepNo ?? null, t.label, t.seconds, t.requestId],
  );
  const { rows } = await q.query<Timer>(`${SELECT_TIMER} WHERE conversation_id = $1 AND request_id = $2`, [t.conversationId, t.requestId]);
  return rows[0]!;
}

/** Running and paused timers, soonest first. */
export async function activeTimers(q: Queryable, conversationId: string): Promise<Timer[]> {
  const { rows } = await q.query<Timer>(
    `${SELECT_TIMER} WHERE conversation_id = $1 AND status IN ('running', 'paused') ORDER BY fires_at NULLS LAST, created_at, id`,
    [conversationId],
  );
  return rows;
}

export async function timerById(q: Queryable, conversationId: string, id: string): Promise<Timer | null> {
  const { rows } = await q.query<Timer>(`${SELECT_TIMER} WHERE conversation_id = $1 AND id = $2`, [conversationId, id]);
  return rows[0] ?? null;
}

/** running → paused, keeping the time left. A paused or finished timer is left as it is. */
export async function pauseTimer(q: Queryable, conversationId: string, id: string): Promise<Timer> {
  await q.query(
    `UPDATE agent.timers
        SET status = 'paused', remaining_s = GREATEST(1, ceil(extract(epoch FROM fires_at - now())))::int, fires_at = NULL
      WHERE conversation_id = $1 AND id = $2 AND status = 'running'`,
    [conversationId, id],
  );
  return (await timerById(q, conversationId, id))!;
}

/** paused → running for the time that was left. Anything else is left as it is. */
export async function resumeTimer(q: Queryable, conversationId: string, id: string): Promise<Timer> {
  await q.query(
    `UPDATE agent.timers SET status = 'running', fires_at = now() + make_interval(secs => remaining_s), remaining_s = NULL
      WHERE conversation_id = $1 AND id = $2 AND status = 'paused'`,
    [conversationId, id],
  );
  return (await timerById(q, conversationId, id))!;
}

/** running or paused → cancelled. A finished timer is left as it is. */
export async function cancelTimer(q: Queryable, conversationId: string, id: string): Promise<Timer> {
  await q.query(
    `UPDATE agent.timers SET status = 'cancelled', fires_at = NULL, remaining_s = NULL
      WHERE conversation_id = $1 AND id = $2 AND status IN ('running', 'paused')`,
    [conversationId, id],
  );
  return (await timerById(q, conversationId, id))!;
}

/** Whether a step already has a timer going, so the app does not offer another (§8.2). */
export async function stepHasTimer(q: Queryable, conversationId: string, sessionId: string, stepNo: number): Promise<boolean> {
  const { rowCount } = await q.query(
    `SELECT 1 FROM agent.timers
      WHERE conversation_id = $1 AND session_id = $2 AND step_no = $3 AND status IN ('running', 'paused')`,
    [conversationId, sessionId, stepNo],
  );
  return rowCount !== 0;
}

/**
 * Scheduler tick (§8.6): fires the household's due timers and writes each `timer_fired` event in
 * one transaction (outbox), so a crash leaves either a running timer or a durable event.
 */
export async function fireDueTimers(q: Queryable, householdId: string): Promise<number> {
  const { rowCount } = await q.query(
    `WITH fired AS (
       UPDATE agent.timers t SET status = 'fired', fired_at = now(), fires_at = NULL
         FROM agent.conversations c
        WHERE c.id = t.conversation_id AND c.household_id = $1 AND t.status = 'running' AND t.fires_at <= now()
        RETURNING t.id, t.conversation_id, t.label, t.step_no, t.session_id)
     INSERT INTO agent.app_events (id, conversation_id, kind, payload, dedupe_key, triggers_turn)
     SELECT gen_random_uuid(), conversation_id, 'timer_fired',
            jsonb_build_object('timer_id', id, 'label', label, 'step_no', step_no, 'session_id', session_id),
            'timer:' || id || ':fired', true
       FROM fired
     ON CONFLICT (conversation_id, dedupe_key) DO NOTHING`,
    [householdId],
  );
  return rowCount ?? 0;
}
