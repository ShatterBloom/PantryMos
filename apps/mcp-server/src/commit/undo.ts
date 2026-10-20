// Committing an undo: the pinned reversals, exactly as confirmed (IMPLEMENTATION_PLAN §4.2, §4.3, §6.6).
import { applyDelta } from '../db/ledger.ts';
import type { Tx } from '../db/tx.ts';
import type { UndoPayload, UndoPreconditions } from '../proposals/undo.ts';
import { checkPinnedBatches, checkPinnedSession } from './consume.ts';
import type { Executor, LockedProposal } from './types.ts';

const payloadOf = (p: LockedProposal) => p.payload as UndoPayload;
const preconditionsOf = (p: LockedProposal) => p.preconditions as UndoPreconditions;

/**
 * §4.3 step 3.4: none of the pinned events was reverted meanwhile. The events themselves are not
 * row-locked: the role may only append to the ledger (I3), and Postgres needs UPDATE rights for any
 * row lock. Reverting an event always writes its batch, whose row the caller already holds, so no
 * concurrent undo of these events can commit between this check and ours. `one_revert_per_event`
 * backs this up, and confirm maps it to `stale_state`.
 */
async function checkEventsNotReverted(tx: Tx, eventIds: readonly string[]): Promise<boolean> {
  const { rowCount } = await tx.query(`SELECT 1 FROM pantry.inventory_events WHERE reverts_event_id = ANY ($1::uuid[])`, [eventIds]);
  return rowCount === 0;
}

export const undoExecutor: Executor = {
  async lockAndCheck(tx, proposal) {
    const { session, batches, events_not_reverted } = preconditionsOf(proposal);
    if (session && !(await checkPinnedSession(tx, session))) return 'session_changed';
    if (!(await checkPinnedBatches(tx, batches))) return 'batch_changed';
    if (!(await checkEventsNotReverted(tx, events_not_reverted))) return 'already_reverted';
    return null;
  },

  summary(proposal) {
    const { scope, target, reverted_operations } = payloadOf(proposal);
    return { scope, target, reverted_operations };
  },

  async execute(tx, proposal, operationId) {
    const { scope, reversals, reverted_operations } = payloadOf(proposal);
    for (const r of reversals) {
      await applyDelta(tx, {
        householdId: proposal.household_id,
        operationId,
        batchId: r.batch_id,
        itemId: r.item_id,
        delta: r.delta,
        reason: 'undo',
        revertsEventId: r.reverts_event_id,
        ...(r.session_id ? { sessionId: r.session_id } : {}),
      });
    }
    await tx.query(`UPDATE pantry.operations SET reverts_operation_ids = $2 WHERE id = $1`, [operationId, reverted_operations]);
    // An operation counts as reverted once every one of its events is.
    await tx.query(
      `UPDATE pantry.operations o SET reverted_by_op = $1
        WHERE o.id = ANY ($2::uuid[]) AND o.reverted_by_op IS NULL
          AND NOT EXISTS (
                SELECT 1 FROM pantry.inventory_events e
                 WHERE e.operation_id = o.id AND e.reason <> 'undo'
                   AND NOT EXISTS (SELECT 1 FROM pantry.inventory_events u WHERE u.reverts_event_id = e.id))`,
      [operationId, reverted_operations],
    );
    // §3.1: undoing the whole meal reverts the session; undoing a correction keeps it consumed.
    if (proposal.target_session_id) {
      await tx.query(
        `UPDATE pantry.cooking_sessions
            SET state = CASE WHEN $2 = 'session' THEN 'reverted' ELSE state END, state_version = state_version + 1
          WHERE id = $1`,
        [proposal.target_session_id, scope],
      );
    }
  },
};
