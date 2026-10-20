// Confirm = commit: one atomic, request-idempotent call (IMPLEMENTATION_PLAN §4.3).
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool } from '../db/pool.ts';
import type { ProposalKind } from '../db/proposals.ts';
import { type Outcome, runIdempotent } from '../db/requestLog.ts';
import type { Tx } from '../db/tx.ts';
import { PantryError } from '../domain/errors.ts';
import { consumeExecutor } from './consume.ts';
import { intakeExecutor } from './intake.ts';
import { reviseExecutor } from './revise.ts';
import { lockActionableProposal, markExpired, notFound, proposalHousehold } from './lock.ts';
import type { Executor, LockedProposal } from './types.ts';

export const ConfirmBody = z
  .object({
    version: z.number().int().min(1),
    user_id: z.string().trim().min(1).max(60),
    channel: z.enum(['ui_click', 'voice_rule']),
    request_id: z.uuid(),
    /** The normalized phrase the ConfirmGate matched (§8.5); required for voice confirmations. */
    utterance: z.string().trim().min(1).max(60).optional(),
  })
  .refine((b) => (b.channel === 'voice_rule') === (b.utterance !== undefined), {
    message: 'utterance is required for voice_rule and not allowed for ui_click',
    path: ['utterance'],
  });

export type ConfirmBody = z.infer<typeof ConfirmBody>;

/** Kinds without an executor yet: adjust and undo (M3). */
const EXECUTORS: Partial<Record<ProposalKind, Executor>> = {
  intake: intakeExecutor,
  consume: consumeExecutor,
  revise_consumption: reviseExecutor,
};

/** Catalog constraints a concurrent creator could hit despite the advisory locks (§4.3 step 3). */
const CATALOG_CONSTRAINTS = new Set(['items_name_ci', 'unit_conversions_pkey']);

/**
 * Confirms exactly `body.version` of a proposal and executes its pinned plan, in one transaction.
 * Every outcome (committed, stale, expired, conflict) is a durable result of this request_id:
 * a retry replays it, and a crash leaves either everything or nothing.
 */
export async function confirmProposal(pool: Pool, proposalId: string, body: ConfirmBody): Promise<Outcome> {
  // The internal API is trusted (service token); the household comes from the proposal row (§11.3).
  const householdId = await proposalHousehold(pool, proposalId);
  if (householdId === null) return notFound();
  return runIdempotent(
    pool,
    {
      householdId,
      requestId: body.request_id,
      scope: 'internal:confirm',
      payload: { proposal_id: proposalId, ...body },
    },
    (tx) => confirmLocked(tx, proposalId, householdId, body),
  );
}

async function confirmLocked(tx: Tx, proposalId: string, householdId: string, body: ConfirmBody): Promise<Outcome> {
  const proposal = await lockActionableProposal(tx, proposalId, householdId, body.version);
  if (proposal.expired) {
    await markExpired(tx, proposalId);
    await insertConfirmation(tx, proposal, body, 'expired');
    return failure('expired', 'This card expired. Please ask again.');
  }

  const executor = EXECUTORS[proposal.kind];
  if (!executor) throw new Error(`No executor for proposal kind ${proposal.kind}`);

  const staleReason = await executor.lockAndCheck(tx, proposal);
  if (staleReason !== null) return markStale(tx, proposal, body, staleReason);

  await tx.query('SAVEPOINT execute');
  try {
    const confirmationId = await insertConfirmation(tx, proposal, body, 'committed');
    const operationId = randomUUID();
    const summary = executor.summary(proposal);
    await tx.query(
      `INSERT INTO pantry.operations (id, household_id, kind, proposal_id, proposal_version, confirmation_id, session_id, summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [operationId, householdId, proposal.kind, proposalId, proposal.version, confirmationId, proposal.target_session_id, summary],
    );
    await executor.execute(tx, proposal, operationId);
    await tx.query(`UPDATE pantry.proposals SET status = 'committed', updated_at = now() WHERE id = $1`, [proposalId]);
    await tx.query('RELEASE SAVEPOINT execute');
    return {
      status: 200,
      body: { status: 'committed', proposal_id: proposalId, version: proposal.version, kind: proposal.kind, operation_id: operationId, summary },
    };
  } catch (err) {
    // The locks above make this unreachable through the normal path; if a unique constraint fires
    // anyway, the card is stale, never a raw database error (§4.3 step 3).
    if (!CATALOG_CONSTRAINTS.has((err as { constraint?: string }).constraint ?? '')) throw err;
    await tx.query('ROLLBACK TO SAVEPOINT execute');
    return markStale(tx, proposal, body, 'catalog_changed');
  }
}

async function markStale(tx: Tx, proposal: LockedProposal, body: ConfirmBody, reason: string): Promise<Outcome> {
  await tx.query(`UPDATE pantry.proposals SET status = 'stale', stale_reason = $2, updated_at = now() WHERE id = $1`, [
    proposal.id,
    reason,
  ]);
  await insertConfirmation(tx, proposal, body, 'stale');
  return failure('stale_state', 'Things changed since this card was made. Refresh it to see the new plan.', { reason });
}

async function insertConfirmation(
  tx: Tx,
  proposal: LockedProposal,
  body: ConfirmBody,
  outcome: 'committed' | 'stale' | 'expired',
): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `INSERT INTO pantry.confirmations (id, household_id, proposal_id, version, user_id, channel, request_id, utterance, outcome)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, proposal.household_id, proposal.id, proposal.version, body.user_id, body.channel, body.request_id, body.utterance ?? null, outcome],
  );
  return id;
}

/** A business failure whose writes (proposal status, confirmation row) must persist. */
function failure(code: 'expired' | 'stale_state', message: string, details: Record<string, unknown> = {}): Outcome {
  return { status: 409, body: new PantryError(code, message, details).toBody() };
}
