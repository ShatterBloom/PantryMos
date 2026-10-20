// Committing a usage revision: the pinned takes and returns, exactly as confirmed (IMPLEMENTATION_PLAN §4.2, §4.3).
import { applyDelta } from '../db/ledger.ts';
import type { RevisePayload, RevisePreconditions } from '../proposals/revise.ts';
import { checkPinnedBatches, checkPinnedSession } from './consume.ts';
import type { Executor, LockedProposal } from './types.ts';

const payloadOf = (p: LockedProposal) => p.payload as RevisePayload;
const preconditionsOf = (p: LockedProposal) => p.preconditions as RevisePreconditions;

export const reviseExecutor: Executor = {
  async lockAndCheck(tx, proposal) {
    const { session, batches } = preconditionsOf(proposal);
    if (!(await checkPinnedSession(tx, session))) return 'session_changed';
    if (!(await checkPinnedBatches(tx, batches))) return 'batch_changed';
    return null;
  },

  summary(proposal) {
    return {
      session_id: proposal.target_session_id,
      lines: payloadOf(proposal)
        .lines.filter((l) => l.status === 'changed')
        .map((l) => ({ item: l.item, from: l.current, to: l.target, unit: l.unit })),
    };
  },

  async execute(tx, proposal, operationId) {
    const sessionId = proposal.target_session_id!;
    for (const a of payloadOf(proposal).allocation) {
      await applyDelta(tx, {
        householdId: proposal.household_id,
        operationId,
        batchId: a.batch_id,
        itemId: a.item_id,
        delta: a.delta,
        reason: 'consume_revision',
        sessionId,
      });
    }
    // §3.1: consumed --confirm(revise_consumption)--> consumed, state_version + 1.
    await tx.query(`UPDATE pantry.cooking_sessions SET state_version = state_version + 1 WHERE id = $1`, [sessionId]);
  },
};
