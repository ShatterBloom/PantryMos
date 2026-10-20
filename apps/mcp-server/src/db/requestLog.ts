// Request idempotency for every non-read request (IMPLEMENTATION_PLAN §5.1).
import { payloadHash } from '@pantrymos/shared';
import { PantryError } from '../domain/errors.ts';
import type { Pool } from './pool.ts';
import { type Tx, withTransaction } from './tx.ts';

export interface RequestKey {
  householdId: string;
  requestId: string;
  /** e.g. 'tool:propose_intake', 'internal:confirm'. */
  scope: string;
  /** Scope-relevant input; its canonical hash detects a reused request_id with different input. */
  payload: unknown;
}

/** A durable request result: success or business error, replayed verbatim on retry. */
export interface Outcome {
  status: number;
  body: unknown;
}

export interface LoggedOutcome extends Outcome {
  replayed: boolean;
}

/**
 * Runs `effect` at most once per (household, request_id), in the same transaction as the log row.
 *
 * - A `PantryError` thrown by `effect` discards the effect's writes and is stored as the outcome.
 * - An `Outcome` returned by `effect` keeps its writes, including business failures that must be
 *   durable (a confirm that marks a proposal stale).
 * - Any other exception rolls back everything, log row included, so the client can retry.
 * - A concurrent duplicate blocks on the primary key until the first transaction ends, then replays.
 */
export async function runIdempotent(
  pool: Pool,
  key: RequestKey,
  effect: (tx: Tx) => Promise<Outcome>,
): Promise<LoggedOutcome> {
  const hash = payloadHash(key.payload);
  return withTransaction(pool, async (tx) => {
    const inserted = await tx.query(
      `INSERT INTO pantry.request_log (household_id, request_id, scope, payload_hash)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING request_id`,
      [key.householdId, key.requestId, key.scope, hash],
    );
    if (inserted.rowCount === 0) return replay(tx, key, hash);

    await tx.query('SAVEPOINT effect');
    let outcome: Outcome;
    try {
      outcome = await effect(tx);
    } catch (err) {
      if (!(err instanceof PantryError)) throw err;
      await tx.query('ROLLBACK TO SAVEPOINT effect');
      outcome = { status: err.status, body: err.toBody() };
    }
    const response = JSON.stringify(outcome.body);
    await tx.query(
      `UPDATE pantry.request_log SET status_code = $3, response = $4 WHERE household_id = $1 AND request_id = $2`,
      [key.householdId, key.requestId, outcome.status, response],
    );
    // Return the stored form, so the first response and every replay are identical.
    return { status: outcome.status, body: JSON.parse(response) as unknown, replayed: false };
  });
}

async function replay(tx: Tx, key: RequestKey, hash: string): Promise<LoggedOutcome> {
  const { rows } = await tx.query<{ scope: string; payload_hash: string; status_code: number; response: unknown }>(
    `SELECT scope, payload_hash, status_code, response FROM pantry.request_log
      WHERE household_id = $1 AND request_id = $2`,
    [key.householdId, key.requestId],
  );
  const row = rows[0];
  if (!row || row.scope !== key.scope || row.payload_hash !== hash) {
    // Not stored: the conflicting request had no effect, and the original stays replayable.
    return {
      status: 409,
      body: new PantryError('request_conflict', 'This request_id was already used for a different request.').toBody(),
      replayed: false,
    };
  }
  return { status: row.status_code, body: row.response, replayed: true };
}
