// Shared entry for user actions on a card (confirm, reject, edit): lock it and check it can be acted on.
import type { Pool } from '../db/pool.ts';
import type { ProposalKind } from '../db/proposals.ts';
import type { Tx } from '../db/tx.ts';
import { PantryError } from '../domain/errors.ts';
import type { LockedProposal } from './types.ts';

/** Household and kind of a proposal (both immutable), read before any transaction. */
export async function proposalHead(pool: Pool, proposalId: string): Promise<{ household_id: string; kind: ProposalKind } | null> {
  const { rows } = await pool.query<{ household_id: string; kind: ProposalKind }>(
    `SELECT household_id, kind FROM pantry.proposals WHERE id = $1`,
    [proposalId],
  );
  return rows[0] ?? null;
}

export async function proposalHousehold(pool: Pool, proposalId: string): Promise<string | null> {
  return (await proposalHead(pool, proposalId))?.household_id ?? null;
}

export const notFound = () => ({ status: 404, body: new PantryError('not_found', 'No such proposal.').toBody() });

/**
 * Lock order (§4.3 step 3): cooking session, then proposal, then batches. Cooking tools lock their
 * session before they write its card, so card actions must take the session first too; otherwise a
 * confirm racing a re-propose (or substitute) deadlocks. A proposal's target session never changes,
 * so it is read without a lock. No-op for proposals without a session.
 */
export async function lockTargetSession(tx: Tx, proposalId: string): Promise<void> {
  await tx.query(
    `SELECT 1 FROM pantry.cooking_sessions
      WHERE id = (SELECT target_session_id FROM pantry.proposals WHERE id = $1)
      FOR UPDATE`,
    [proposalId],
  );
}

/**
 * Locks the proposal row (FOR UPDATE), after its session (see lockTargetSession), and checks it is still the pending `version` the user saw:
 * already_committed (with the original operation), not_pending, or stale_proposal otherwise.
 * Expiry is left to the caller, which decides what to record.
 */
export async function lockActionableProposal(
  tx: Tx,
  proposalId: string,
  householdId: string,
  version: number,
): Promise<LockedProposal> {
  await lockTargetSession(tx, proposalId);
  const { rows } = await tx.query<LockedProposal>(
    `SELECT id, household_id, conversation_id, kind, version, status, input, payload, preconditions, target_session_id,
            expires_at <= now() AS expired
       FROM pantry.proposals WHERE id = $1 AND household_id = $2
       FOR UPDATE`,
    [proposalId, householdId],
  );
  const proposal = rows[0]!;

  if (proposal.status === 'committed') {
    const op = await tx.query<{ id: string; proposal_version: number; summary: unknown }>(
      `SELECT id, proposal_version, summary FROM pantry.operations WHERE proposal_id = $1`,
      [proposalId],
    );
    throw new PantryError('already_committed', 'This card was already confirmed.', {
      operation_id: op.rows[0]?.id,
      version: op.rows[0]?.proposal_version,
      summary: op.rows[0]?.summary,
    });
  }
  if (proposal.status !== 'pending') {
    throw new PantryError('not_pending', `This card is ${proposal.status} and can no longer be changed.`, {
      status: proposal.status,
    });
  }
  if (proposal.version !== version) {
    throw new PantryError('stale_proposal', 'This card changed. Please review it again.', {
      current_version: proposal.version,
    });
  }
  return proposal;
}

export async function markExpired(tx: Tx, proposalId: string): Promise<void> {
  await tx.query(`UPDATE pantry.proposals SET status = 'expired', updated_at = now() WHERE id = $1`, [proposalId]);
}
