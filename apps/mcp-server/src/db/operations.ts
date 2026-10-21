// Committed operations, as the ledger records them (IMPLEMENTATION_PLAN §2.1, §7.4 list_recent_operations).
import type { ProposalKind } from './proposals.ts';
import type { Queryable } from './catalog.ts';

export interface OperationRow {
  operation_id: string;
  kind: ProposalKind;
  session_id: string | null;
  recipe: string | null;
  reverted: boolean;
  created_at: Date;
  /** Net change per item over the operation's events, in base units. */
  changes: Array<{ item_id: string; delta: number }>;
}

export interface OperationHead {
  id: string;
  kind: ProposalKind;
  session_id: string | null;
  recipe: string | null;
  reverted: boolean;
}

const SELECT_HEAD = `
  SELECT o.id, o.kind, o.session_id, r.name AS recipe, o.reverted_by_op IS NOT NULL AS reverted
    FROM pantry.operations o
    LEFT JOIN pantry.cooking_sessions s ON s.id = o.session_id
    LEFT JOIN pantry.recipes r ON r.id = s.recipe_id`;

/**
 * An operation by its id, or by the id of the card that committed it: a model holding the card it
 * just saw confirmed undoes "that" by the card's id (eval P2a).
 */
export async function operationById(q: Queryable, householdId: string, id: string): Promise<OperationHead | null> {
  const { rows } = await q.query<OperationHead>(`${SELECT_HEAD} WHERE o.household_id = $1 AND (o.id = $2 OR o.proposal_id = $2)`, [
    householdId,
    id,
  ]);
  return rows[0] ?? null;
}

/** §6.6 `target: "last"`: the most recent operation that is not an undo and not reverted. */
export async function lastUndoable(q: Queryable, householdId: string): Promise<OperationHead | null> {
  const { rows } = await q.query<OperationHead>(
    `${SELECT_HEAD}
      WHERE o.household_id = $1 AND o.kind <> 'undo' AND o.reverted_by_op IS NULL
      ORDER BY o.created_at DESC, o.id
      LIMIT 1`,
    [householdId],
  );
  return rows[0] ?? null;
}

/** A ledger event that no undo has reverted yet. */
export interface LiveEvent {
  event_id: string;
  operation_id: string;
  batch_id: string;
  item_id: string;
  delta: number;
  session_id: string | null;
}

const LIVE_EVENTS = `
  SELECT e.id AS event_id, e.operation_id, e.batch_id, e.item_id, e.delta::text AS delta, e.session_id
    FROM pantry.inventory_events e
   WHERE e.reason <> 'undo'
     AND NOT EXISTS (SELECT 1 FROM pantry.inventory_events u WHERE u.reverts_event_id = e.id)`;

const toLive = (rows: Array<Omit<LiveEvent, 'delta'> & { delta: string }>): LiveEvent[] =>
  rows.map((r) => ({ ...r, delta: Number(r.delta) }));

/** §6.6 scope = operation: the operation's events not yet reverted. */
export async function liveEventsOfOperation(q: Queryable, operationId: string): Promise<LiveEvent[]> {
  const { rows } = await q.query<Omit<LiveEvent, 'delta'> & { delta: string }>(
    `${LIVE_EVENTS} AND e.operation_id = $1 ORDER BY e.created_at, e.id`,
    [operationId],
  );
  return toLive(rows);
}

/** §6.6 scope = session: the meal's consume and revision events not yet reverted. */
export async function liveEventsOfSession(q: Queryable, sessionId: string): Promise<LiveEvent[]> {
  const { rows } = await q.query<Omit<LiveEvent, 'delta'> & { delta: string }>(
    `${LIVE_EVENTS} AND e.session_id = $1 AND e.reason IN ('consume', 'consume_revision') ORDER BY e.created_at, e.id`,
    [sessionId],
  );
  return toLive(rows);
}

/** Revisions of a meal that are not reverted: undoing the meal's consume alone would orphan them. */
export async function liveRevisions(q: Queryable, sessionId: string): Promise<string[]> {
  const { rows } = await q.query<{ id: string }>(
    `SELECT id FROM pantry.operations
      WHERE session_id = $1 AND kind = 'revise_consumption' AND reverted_by_op IS NULL
      ORDER BY created_at, id`,
    [sessionId],
  );
  return rows.map((r) => r.id);
}

/** A meal's consume and revisions not yet reverted, with or without events: what undoing the meal reverts. */
export async function liveMealOperations(q: Queryable, sessionId: string): Promise<string[]> {
  const { rows } = await q.query<{ id: string }>(
    `SELECT id FROM pantry.operations
      WHERE session_id = $1 AND kind IN ('consume', 'revise_consumption') AND reverted_by_op IS NULL
      ORDER BY created_at, id`,
    [sessionId],
  );
  return rows.map((r) => r.id);
}

/** The household's most recent operations, newest first. */
export async function recentOperations(q: Queryable, householdId: string, limit: number): Promise<OperationRow[]> {
  const { rows } = await q.query<Omit<OperationRow, 'changes'> & { changes: Array<{ item_id: string; delta: string }> }>(
    `SELECT o.id AS operation_id, o.kind, o.session_id, r.name AS recipe, o.reverted_by_op IS NOT NULL AS reverted,
            o.created_at,
            COALESCE((SELECT json_agg(json_build_object('item_id', e.item_id, 'delta', e.delta::text) ORDER BY e.item_id)
                        FROM (SELECT item_id, sum(delta) AS delta FROM pantry.inventory_events
                               WHERE operation_id = o.id GROUP BY item_id HAVING sum(delta) <> 0) e), '[]') AS changes
       FROM pantry.operations o
       LEFT JOIN pantry.cooking_sessions s ON s.id = o.session_id
       LEFT JOIN pantry.recipes r ON r.id = s.recipe_id
      WHERE o.household_id = $1
      ORDER BY o.created_at DESC, o.id
      LIMIT $2`,
    [householdId, limit],
  );
  return rows.map((r) => ({ ...r, changes: r.changes.map((c) => ({ item_id: c.item_id, delta: Number(c.delta) })) }));
}
