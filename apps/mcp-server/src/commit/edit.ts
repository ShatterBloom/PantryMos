// Card edits and Refresh (§4.4): re-plan from current state with the original tool logic.
import { z } from 'zod';
import type { Pool } from '../db/pool.ts';
import { type Outcome, runIdempotent } from '../db/requestLog.ts';
import { PantryError } from '../domain/errors.ts';
import { PLANNERS } from '../proposals/registry.ts';
import { lockActionableProposal, lockTargetSession, markExpired, notFound, proposalHead } from './lock.ts';

export const EditBody = z.object({
  base_version: z.number().int().min(1),
  changes: z.unknown(),
  request_id: z.uuid(),
});
export type EditBody = z.infer<typeof EditBody>;

export const RegenerateBody = z.object({ request_id: z.uuid() });
export type RegenerateBody = z.infer<typeof RegenerateBody>;

const badRequest = (message: string, issues: unknown[] = []): Outcome => ({ status: 400, body: { error: 'bad_request', message, issues } });

/**
 * PATCH /internal/proposals/:id: the user edited the card. Merges the changes into the stored input
 * and re-plans against current state; a different plan appends version + 1, an identical one keeps
 * the version. Requires `base_version` to be the version the user edited.
 */
export async function editProposal(pool: Pool, proposalId: string, body: EditBody): Promise<Outcome> {
  const head = await proposalHead(pool, proposalId);
  if (!head) return notFound();
  const planner = PLANNERS[head.kind];
  const changes = planner.Changes.safeParse(body.changes);
  if (!changes.success) return badRequest('Invalid changes for this card.', changes.error.issues);

  return runIdempotent(
    pool,
    { householdId: head.household_id, requestId: body.request_id, scope: 'internal:edit', payload: { proposal_id: proposalId, ...body } },
    async (tx) => {
      const proposal = await lockActionableProposal(tx, proposalId, head.household_id, body.base_version);
      if (proposal.expired) {
        await markExpired(tx, proposalId);
        return { status: 409, body: new PantryError('expired', 'This card expired. Refresh it to start again.').toBody() };
      }
      const input = planner.merge(proposal.input, changes.data);
      const ref = await planner.propose(tx, head.household_id, proposal.conversation_id, input);
      if (ref.proposal_id === proposalId) return { status: 200, body: { ...ref, kind: head.kind } };
      // A new amount can change which batches an adjustment touches, and so its subject (§4.1): the
      // edit then lands on another card, which replaces this one.
      await tx.query(`UPDATE pantry.proposals SET status = 'superseded', updated_at = now() WHERE id = $1`, [proposalId]);
      return { status: 200, body: { ...ref, kind: head.kind, superseded: proposalId } };
    },
  );
}

/**
 * POST /internal/proposals/:id/regenerate (the card's Refresh): for a stale or expired card, re-runs
 * the original tool on the stored input and returns a new pending proposal with its own version 1,
 * or the business error the tool gives today.
 */
export async function regenerateProposal(pool: Pool, proposalId: string, body: RegenerateBody): Promise<Outcome> {
  const head = await proposalHead(pool, proposalId);
  if (!head) return notFound();
  const planner = PLANNERS[head.kind];

  return runIdempotent(
    pool,
    { householdId: head.household_id, requestId: body.request_id, scope: 'internal:regenerate', payload: { proposal_id: proposalId } },
    async (tx) => {
      await lockTargetSession(tx, proposalId);
      const { rows } = await tx.query<{ status: string; expired: boolean; input: unknown; conversation_id: string }>(
        `SELECT status, expires_at <= now() AS expired, input, conversation_id FROM pantry.proposals WHERE id = $1 FOR UPDATE`,
        [proposalId],
      );
      const old = rows[0]!;
      if (old.status === 'pending' && old.expired) {
        await markExpired(tx, proposalId);
      } else if (old.status !== 'stale' && old.status !== 'expired') {
        throw new PantryError('invalid_state', `Only stale or expired cards can be refreshed; this one is ${old.status}.`, {
          status: old.status,
        });
      }
      const ref = await planner.propose(tx, head.household_id, old.conversation_id, old.input);
      return { status: 200, body: { ...ref, kind: head.kind, regenerated_from: proposalId } };
    },
  );
}
