// Confirm = commit: one atomic, request-idempotent call (IMPLEMENTATION_PLAN §4.3).
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool } from '../db/pool.ts';
import type { ProposalKind } from '../db/proposals.ts';
import { type Outcome, runIdempotent } from '../db/requestLog.ts';
import type { Tx } from '../db/tx.ts';
import { PantryError } from '../domain/errors.ts';
import { intakeExecutor } from './intake.ts';
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

/** Kinds without an executor yet are added by later milestones (consume: M2; revise, adjust, undo: M3). */
const EXECUTORS: Partial<Record<ProposalKind, Executor>> = {
  intake: intakeExecutor,
};

/** Catalog constraints a concurrent creator could hit despite the advisory locks (§4.3 step 3). */
const CATALOG_CONSTRAINTS = new Set(['items_name_ci', 'unit_conversions_pkey']);

export async function proposalHousehold(pool: Pool, proposalId: string): Promise<string | null> {
  const { rows } = await pool.query<{ household_id: string }>(`SELECT household_id FROM pantry.proposals WHERE id = $1`, [
    proposalId,
  ]);
  return rows[0]?.household_id ?? null;
}

/**
 * Confirms exactly `body.version` of a proposal and executes its pinned plan, in one transaction.
 * Every outcome (committed, stale, expired, conflict) is a durable result of this request_id:
 * a retry replays it, and a crash leaves either everything or nothing.
 */
export async function confirmProposal(pool: Pool, proposalId: string, body: ConfirmBody): Promise<Outcome> {
  // The internal API is trusted (service token); the household comes from the proposal row (§11.3).
  const householdId = await proposalHousehold(pool, proposalId);
  if (householdId === null) {
    return { status: 404, body: new PantryError('not_found', 'No such proposal.').toBody() };
  }
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
  const { rows } = await tx.query<LockedProposal>(
    `SELECT id, household_id, conversation_id, kind, version, status, payload, preconditions, target_session_id,
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
    throw new PantryError('not_pending', `This card is ${proposal.status} and can no longer be confirmed.`, {
      status: proposal.status,
    });
  }
  if (proposal.version !== body.version) {
    throw new PantryError('stale_proposal', 'This card changed. Please review it again.', {
      current_version: proposal.version,
    });
  }

  if (proposal.expired) {
    await tx.query(`UPDATE pantry.proposals SET status = 'expired', updated_at = now() WHERE id = $1`, [proposalId]);
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
