// Cooking sessions (IMPLEMENTATION_PLAN §2.1, §3.1, §7.2).
import { canonicalJson } from '@pantrymos/shared';
import type { PlannedLine } from '../domain/cooking.ts';
import { PantryError } from '../domain/errors.ts';
import type { BaseUnit } from '../domain/items.ts';
import type { Queryable } from './catalog.ts';
import type { Tx } from './tx.ts';

export type SessionState = 'cooking' | 'awaiting_confirmation' | 'consumed' | 'cancelled' | 'reverted';
export const ACTIVE_STATES: readonly SessionState[] = ['cooking', 'awaiting_confirmation'];

export interface SessionRow {
  id: string;
  household_id: string;
  conversation_id: string;
  recipe_id: string;
  recipe: string;
  servings: number;
  state: SessionState;
  total_steps: number;
  current_step: number;
  planned_usage: PlannedLine[];
  state_version: number;
  consumed_at: Date | null;
}

const SELECT_SESSION = `
  SELECT s.id, s.household_id, s.conversation_id, s.recipe_id, r.name AS recipe, s.servings, s.state,
         s.total_steps, s.current_step, s.planned_usage, s.state_version, s.consumed_at
    FROM pantry.cooking_sessions s JOIN pantry.recipes r ON r.id = s.recipe_id`;

/**
 * Locks the session a cooking tool acts on (§7.2): the given one, or the household's active one.
 * The session must be active; `no_active_session` otherwise.
 */
export async function lockActiveSession(tx: Tx, householdId: string, sessionId?: string): Promise<SessionRow> {
  const { rows } = await tx.query<SessionRow>(
    `${SELECT_SESSION}
      WHERE s.household_id = $1 AND ($2::uuid IS NULL OR s.id = $2)
        AND ($2::uuid IS NOT NULL OR s.state IN ('cooking', 'awaiting_confirmation'))
      FOR UPDATE OF s`,
    [householdId, sessionId ?? null],
  );
  const session = rows[0];
  if (!session) {
    throw new PantryError('no_active_session', sessionId ? 'There is no such cooking session.' : 'Nothing is cooking right now.');
  }
  if (!ACTIVE_STATES.includes(session.state)) {
    throw new PantryError('invalid_state', `That cooking session is already ${session.state}.`, { state: session.state });
  }
  return session;
}

/** get_session's target: the given session, else the active one, else the most recent one. */
export async function findSession(q: Queryable, householdId: string, sessionId?: string): Promise<SessionRow | null> {
  const { rows } = await q.query<SessionRow>(
    `${SELECT_SESSION}
      WHERE s.household_id = $1 AND ($2::uuid IS NULL OR s.id = $2)
      ORDER BY (s.state IN ('cooking', 'awaiting_confirmation')) DESC, s.started_at DESC
      LIMIT 1`,
    [householdId, sessionId ?? null],
  );
  return rows[0] ?? null;
}

/** Active stock per item, in base units. */
export async function availableByItem(q: Queryable, householdId: string): Promise<Map<string, number>> {
  const { rows } = await q.query<{ item_id: string; total: string }>(
    `SELECT item_id, sum(quantity)::text AS total FROM pantry.batches
      WHERE household_id = $1 AND status = 'active' GROUP BY item_id`,
    [householdId],
  );
  return new Map(rows.map((r) => [r.item_id, Number(r.total)]));
}

export async function itemInfo(q: Queryable, householdId: string): Promise<Map<string, { name: string; base_unit: BaseUnit }>> {
  const { rows } = await q.query<{ id: string; name: string; base_unit: BaseUnit }>(
    `SELECT id, name, base_unit FROM pantry.items WHERE household_id = $1`,
    [householdId],
  );
  return new Map(rows.map((r) => [r.id, { name: r.name, base_unit: r.base_unit }]));
}

/**
 * Effective usage of a session per item (invariant I5): what its consume and revision events took,
 * net of undo events. Undo events carry the session id of the events they revert.
 */
export async function effectiveUsage(q: Queryable, sessionId: string): Promise<Map<string, number>> {
  const { rows } = await q.query<{ item_id: string; used: string }>(
    `SELECT item_id, (-sum(delta))::text AS used FROM pantry.inventory_events
      WHERE session_id = $1 AND reason IN ('consume', 'consume_revision', 'undo')
      GROUP BY item_id`,
    [sessionId],
  );
  return new Map(rows.map((r) => [r.item_id, Number(r.used)]));
}

/** consume proposals are keyed per session (§4.1). */
export const consumeSubject = (sessionId: string) => `consume:session:${sessionId}`;

/** A pending consume card no longer matches the plan: it can never be confirmed (§3.1, §3.2). */
export async function supersedePendingConsume(tx: Tx, sessionId: string): Promise<void> {
  await tx.query(
    `UPDATE pantry.proposals SET status = 'superseded', updated_at = now()
      WHERE subject_key = $1 AND status = 'pending'`,
    [consumeSubject(sessionId)],
  );
}

/**
 * Stores a changed plan (§3.1 substitute / skip_ingredient): bumps state_version, returns an
 * awaiting session to cooking and supersedes its card. An identical plan changes nothing.
 * Returns whether anything changed.
 */
export async function updatePlan(tx: Tx, session: SessionRow, plan: readonly PlannedLine[]): Promise<boolean> {
  if (canonicalJson(plan) === canonicalJson(session.planned_usage)) return false;
  await tx.query(
    `UPDATE pantry.cooking_sessions
        SET planned_usage = $2, state = 'cooking', state_version = state_version + 1
      WHERE id = $1`,
    [session.id, JSON.stringify(plan)],
  );
  await supersedePendingConsume(tx, session.id);
  return true;
}
