// Append-only ledger writes (IMPLEMENTATION_PLAN §2.3: I1, I3, I8).
import { randomUUID } from 'node:crypto';
import type { Tx } from './tx.ts';

export type EventReason = 'purchase' | 'consume' | 'consume_revision' | 'adjust' | 'discard' | 'undo';

export interface Delta {
  householdId: string;
  operationId: string;
  batchId: string;
  itemId: string;
  delta: number;
  reason: EventReason;
  sessionId?: string;
  revertsEventId?: string;
}

/**
 * Records one inventory event and applies it to its batch in the same transaction, so
 * `batches.quantity = Σ events` (I1). Bumps the batch version (stale detection, §4.2) and
 * recomputes status (I8): active while it has stock; at zero, discarded if a discard emptied it
 * (or it was already discarded), else depleted. The `quantity >= 0` CHECK rejects an overdraw.
 */
export async function applyDelta(tx: Tx, d: Delta): Promise<string> {
  const eventId = randomUUID();
  await tx.query(
    `INSERT INTO pantry.inventory_events
       (id, household_id, operation_id, batch_id, item_id, delta, reason, session_id, reverts_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [eventId, d.householdId, d.operationId, d.batchId, d.itemId, d.delta, d.reason, d.sessionId ?? null, d.revertsEventId ?? null],
  );
  const updated = await tx.query(
    `UPDATE pantry.batches
        SET quantity = quantity + $3,
            version  = version + 1,
            status   = CASE WHEN quantity + $3 > 0 THEN 'active'
                            WHEN $4 = 'discard' OR status = 'discarded' THEN 'discarded'
                            ELSE 'depleted' END
      WHERE id = $1 AND household_id = $2`,
    [d.batchId, d.householdId, d.delta, d.reason],
  );
  if (updated.rowCount !== 1) throw new Error(`Batch ${d.batchId} not found in household ${d.householdId}`);
  return eventId;
}

/** Takes transaction-scoped advisory locks in sorted order, so concurrent lockers never deadlock. */
export async function lockKeys(tx: Tx, keys: readonly string[]): Promise<void> {
  for (const key of [...new Set(keys)].sort()) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
  }
}
