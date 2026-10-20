// Shared entry for user actions on a card (confirm, reject, edit): lock it and check it can be acted on.
import type { Pool } from '../db/pool.ts';
import type { Tx } from '../db/tx.ts';
import { PantryError } from '../domain/errors.ts';
import type { LockedProposal } from './types.ts';

export async function proposalHousehold(pool: Pool, proposalId: string): Promise<string | null> {
  const { rows } = await pool.query<{ household_id: string }>(`SELECT household_id FROM pantry.proposals WHERE id = $1`, [
    proposalId,
  ]);
  return rows[0]?.household_id ?? null;
}

export const notFound = () => ({ status: 404, body: new PantryError('not_found', 'No such proposal.').toBody() });

/**
 * Locks the proposal row (FOR UPDATE) and checks it is still the pending `version` the user saw:
 * already_committed (with the original operation), not_pending, or stale_proposal otherwise.
 * Expiry is left to the caller, which decides what to record.
 */
export async function lockActionableProposal(
  tx: Tx,
  proposalId: string,
  householdId: string,
  version: number,
): Promise<LockedProposal> {
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
