// Agent-side idempotency (IMPLEMENTATION_PLAN §5.2): claimed in one short transaction, completed in another,
// because a chat turn spans model calls that must not hold a transaction open.
import { payloadHash } from '@pantrymos/shared';
import type { Pool, Queryable } from '../db.ts';

export interface RequestKey {
  conversationId: string;
  requestId: string;
  /** e.g. 'api:chat', 'api:ack', 'api:confirm'. */
  route: string;
  payload: unknown;
}

/** The step the user last heard when the turn began (§7.4 `expected_step`). */
export interface TurnSnapshot {
  session_id: string;
  step_no: number;
}

export type Claim =
  /** First time: run the request. */
  | { kind: 'new' }
  /** A crashed attempt's lease expired: resume it (§8.2). `started` once its turn persisted its input. */
  | { kind: 'resume'; started: boolean; snapshot: TurnSnapshot | null }
  | { kind: 'done'; status: number; response: unknown }
  | { kind: 'conflict' }
  | { kind: 'in_progress'; retryAfterSeconds: number };

export const REQUEST_LEASE_MS = 120_000;

export async function claimRequest(pool: Pool, key: RequestKey, leaseMs = REQUEST_LEASE_MS): Promise<Claim> {
  const hash = payloadHash(key.payload);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO agent.request_log (conversation_id, request_id, route, payload_hash, status, lease_until)
       VALUES ($1, $2, $3, $4, 'in_progress', now() + make_interval(secs => $5::float / 1000))
       ON CONFLICT DO NOTHING RETURNING request_id`,
      [key.conversationId, key.requestId, key.route, hash, leaseMs],
    );
    let claim: Claim;
    if (inserted.rowCount === 1) {
      claim = { kind: 'new' };
    } else {
      const { rows } = await client.query<{
        route: string;
        payload_hash: string;
        status: 'in_progress' | 'done' | 'failed';
        expired: boolean;
        retry_after: number;
        started: boolean;
        turn_snapshot: TurnSnapshot | null;
        response: { status: number; body: unknown } | null;
      }>(
        `SELECT route, payload_hash, status, lease_until <= now() AS expired,
                GREATEST(1, ceil(extract(epoch FROM lease_until - now())))::int AS retry_after,
                started, turn_snapshot, response
           FROM agent.request_log WHERE conversation_id = $1 AND request_id = $2 FOR UPDATE`,
        [key.conversationId, key.requestId],
      );
      const row = rows[0]!;
      if (row.route !== key.route || row.payload_hash !== hash) {
        claim = { kind: 'conflict' };
      } else if (row.status !== 'in_progress') {
        claim = { kind: 'done', status: row.response!.status, response: row.response!.body };
      } else if (!row.expired) {
        claim = { kind: 'in_progress', retryAfterSeconds: row.retry_after };
      } else {
        await client.query(
          `UPDATE agent.request_log SET lease_until = now() + make_interval(secs => $3::float / 1000)
            WHERE conversation_id = $1 AND request_id = $2`,
          [key.conversationId, key.requestId, leaseMs],
        );
        claim = { kind: 'resume', started: row.started, snapshot: row.turn_snapshot };
      }
    }
    await client.query('COMMIT');
    return claim;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Records that the turn persisted its input, with the step snapshot it injects (§8.2). */
export async function markStarted(q: Queryable, conversationId: string, requestId: string, snapshot: TurnSnapshot | null): Promise<void> {
  await q.query(`UPDATE agent.request_log SET started = true, turn_snapshot = $3 WHERE conversation_id = $1 AND request_id = $2`, [
    conversationId,
    requestId,
    snapshot === null ? null : JSON.stringify(snapshot),
  ]);
}

/** Stores the response, in the same transaction as the request's final writes (§5.2). */
export async function completeRequest(
  q: Queryable,
  conversationId: string,
  requestId: string,
  response: { status: number; body: unknown },
): Promise<void> {
  await q.query(
    `UPDATE agent.request_log SET status = $3, response = $4 WHERE conversation_id = $1 AND request_id = $2`,
    [conversationId, requestId, response.status < 400 ? 'done' : 'failed', JSON.stringify(response)],
  );
}

/** Drops a claim whose request failed with a fault, so a retry starts over. */
export async function abandonRequest(q: Queryable, conversationId: string, requestId: string): Promise<void> {
  await q.query(`UPDATE agent.request_log SET lease_until = now() WHERE conversation_id = $1 AND request_id = $2 AND status = 'in_progress'`, [
    conversationId,
    requestId,
  ]);
}

/** The stored response once the request finished, else null (checked again under the conversation lease). */
export async function finishedResponse(q: Queryable, conversationId: string, requestId: string): Promise<{ status: number; body: unknown } | null> {
  const { rows } = await q.query<{ response: { status: number; body: unknown } | null }>(
    `SELECT response FROM agent.request_log WHERE conversation_id = $1 AND request_id = $2 AND status <> 'in_progress'`,
    [conversationId, requestId],
  );
  return rows[0]?.response ?? null;
}
