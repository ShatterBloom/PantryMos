// Committing a consumption card: the pinned allocation, exactly as confirmed (IMPLEMENTATION_PLAN §4.2, §4.3).
import { applyDelta } from '../db/ledger.ts';
import type { Tx } from '../db/tx.ts';
import type { ConsumePayload, ConsumePreconditions } from '../proposals/consume.ts';
import type { Executor, LockedProposal } from './types.ts';

const payloadOf = (p: LockedProposal) => p.payload as ConsumePayload;
const preconditionsOf = (p: LockedProposal) => p.preconditions as ConsumePreconditions;

/**
 * Locks the session, then the pinned batches ordered by id (§4.3 step 3), and checks that none
 * changed since the card was made. A changed batch makes the card stale even if other batches
 * could cover the meal: confirm never re-allocates (FR-17, R20).
 */
export async function checkPinnedBatches(tx: Tx, pinned: ReadonlyArray<{ id: string; version: number }>): Promise<boolean> {
  if (pinned.length === 0) return true;
  const { rows } = await tx.query<{ id: string; version: number }>(
    `SELECT id, version FROM pantry.batches WHERE id = ANY ($1::uuid[]) ORDER BY id FOR UPDATE`,
    [pinned.map((b) => b.id)],
  );
  const current = new Map(rows.map((r) => [r.id, r.version]));
  return pinned.every((b) => current.get(b.id) === b.version);
}

export async function checkPinnedSession(
  tx: Tx,
  pinned: { id: string; state: string; state_version: number },
): Promise<boolean> {
  const { rows } = await tx.query<{ state: string; state_version: number }>(
    `SELECT state, state_version FROM pantry.cooking_sessions WHERE id = $1 FOR UPDATE`,
    [pinned.id],
  );
  const session = rows[0];
  return session !== undefined && session.state === pinned.state && session.state_version === pinned.state_version;
}

export const consumeExecutor: Executor = {
  async lockAndCheck(tx, proposal) {
    const { session, batches } = preconditionsOf(proposal);
    if (!(await checkPinnedSession(tx, session))) return 'session_changed';
    if (!(await checkPinnedBatches(tx, batches))) return 'batch_changed';
    return null;
  },

  summary(proposal) {
    return {
      session_id: proposal.target_session_id,
      lines: payloadOf(proposal).lines.map((l) => ({ item: l.item, quantity: l.quantity, unit: l.unit })),
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
        reason: 'consume',
        sessionId,
      });
    }
    await tx.query(
      `UPDATE pantry.cooking_sessions
          SET state = 'consumed', consumed_at = now(), ended_at = now(), state_version = state_version + 1
        WHERE id = $1`,
      [sessionId],
    );
  },
};
