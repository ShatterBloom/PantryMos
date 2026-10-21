// Committing a stock adjustment: the pinned batch changes, or the new batch, exactly as confirmed (§4.2, §4.3).
import { randomUUID } from 'node:crypto';
import { applyDelta } from '../db/ledger.ts';
import { roundQuantity } from '../domain/units.ts';
import type { AdjustPayload, AdjustPreconditions } from '../proposals/adjust.ts';
import { checkPinnedBatches } from './consume.ts';
import type { Executor, LockedProposal } from './types.ts';

const payloadOf = (p: LockedProposal) => p.payload as AdjustPayload;
const preconditionsOf = (p: LockedProposal) => p.preconditions as AdjustPreconditions;

export const adjustExecutor: Executor = {
  async lockAndCheck(tx, proposal) {
    return (await checkPinnedBatches(tx, preconditionsOf(proposal).batches)) ? null : 'batch_changed';
  },

  summary(proposal) {
    const { item, unit, reason, note, set_quantity, allocation, new_batch } = payloadOf(proposal);
    const delta = allocation.reduce((sum, a) => sum + a.delta, 0) + (new_batch?.quantity ?? 0);
    return { item, unit, reason, note, delta: roundQuantity(delta), set_quantity, new_batch: new_batch !== null };
  },

  async execute(tx, proposal, operationId) {
    const householdId = proposal.household_id;
    const { reason, allocation, new_batch } = payloadOf(proposal);
    const eventReason = reason === 'discard' ? 'discard' : 'adjust';
    for (const a of allocation) {
      await applyDelta(tx, { householdId, operationId, batchId: a.batch_id, itemId: a.item_id, delta: a.delta, reason: eventReason });
    }
    if (new_batch) {
      const batchId = randomUUID();
      // Created empty (version 0) like an intake batch; the +Q adjust event brings it to its quantity (I1).
      await tx.query(
        `INSERT INTO pantry.batches (id, household_id, item_id, quantity, purchased_at, priority_date, priority_source,
                                     status, version, created_by_op)
         VALUES ($1, $2, $3, 0, $4, $5, $6, 'depleted', 0, $7)`,
        [batchId, householdId, new_batch.item_id, new_batch.purchased_at, new_batch.priority_date, new_batch.priority_source, operationId],
      );
      await applyDelta(tx, { householdId, operationId, batchId, itemId: new_batch.item_id, delta: new_batch.quantity, reason: 'adjust' });
    }
  },
};
