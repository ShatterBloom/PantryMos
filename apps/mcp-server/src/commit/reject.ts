// Rejecting a card (§4.4): it can never be confirmed; a consume card hands the session back to cooking.
import { z } from 'zod';
import type { Pool } from '../db/pool.ts';
import { type Outcome, runIdempotent } from '../db/requestLog.ts';
import { PantryError } from '../domain/errors.ts';
import { lockActionableProposal, markExpired, notFound, proposalHousehold } from './lock.ts';

export const RejectBody = z.object({
  version: z.number().int().min(1),
  request_id: z.uuid(),
});

export type RejectBody = z.infer<typeof RejectBody>;

export async function rejectProposal(pool: Pool, proposalId: string, body: RejectBody): Promise<Outcome> {
  const householdId = await proposalHousehold(pool, proposalId);
  if (householdId === null) return notFound();
  return runIdempotent(
    pool,
    { householdId, requestId: body.request_id, scope: 'internal:reject', payload: { proposal_id: proposalId, ...body } },
    async (tx) => {
      const proposal = await lockActionableProposal(tx, proposalId, householdId, body.version);
      if (proposal.expired) {
        await markExpired(tx, proposalId);
        return { status: 409, body: new PantryError('expired', 'This card already expired.').toBody() };
      }
      await tx.query(`UPDATE pantry.proposals SET status = 'rejected', updated_at = now() WHERE id = $1`, [proposalId]);
      if (proposal.kind === 'consume' && proposal.target_session_id) {
        // §3.1: awaiting_confirmation --reject--> cooking.
        await tx.query(
          `UPDATE pantry.cooking_sessions SET state = 'cooking', state_version = state_version + 1
            WHERE id = $1 AND state = 'awaiting_confirmation'`,
          [proposal.target_session_id],
        );
      }
      return { status: 200, body: { status: 'rejected', proposal_id: proposalId, version: proposal.version, kind: proposal.kind } };
    },
  );
}
