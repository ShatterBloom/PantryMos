// Proposal storage: the subject-key upsert rule and append-only version history (IMPLEMENTATION_PLAN §4.1).
import { randomUUID } from 'node:crypto';
import { canonicalJson } from '@pantrymos/shared';
import { PantryError } from '../domain/errors.ts';
import type { Queryable } from './catalog.ts';
import type { Tx } from './tx.ts';

export type ProposalKind = 'intake' | 'consume' | 'revise_consumption' | 'adjust' | 'undo';

/** How long a pending card stays confirmable (§3.2). */
export const PROPOSAL_TTL_HOURS = 2;

export interface ProposalDraft {
  kind: ProposalKind;
  subjectKey: string;
  conversationId: string;
  targetSessionId?: string;
  targetOperationId?: string;
  /** Normalized tool input, re-run by regenerate. */
  input: unknown;
  /** Card lines plus the pinned plan. */
  payload: unknown;
  /** Pinned state the plan depends on; any change makes the card stale at confirm. */
  preconditions: unknown;
}

export interface ProposalRef {
  proposal_id: string;
  version: number;
  expires_at: string;
  /** 'unchanged': an identical pending plan existed, so the same version is returned. */
  outcome: 'created' | 'new_version' | 'unchanged';
}

const UNIQUE_VIOLATION = '23505';

/**
 * Creates or updates the one pending proposal for `draft.subjectKey`, inside the caller's transaction:
 * identical plan → same version; different plan → version + 1; none → version 1. Every version is
 * appended to `proposal_versions` in the same transaction as the current copy.
 */
export async function upsertProposal(tx: Tx, householdId: string, draft: ProposalDraft): Promise<ProposalRef> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await lockPendingSubject(tx, householdId, draft.subjectKey);
    if (existing) return updateExisting(tx, existing, draft);

    await tx.query('SAVEPOINT proposal_insert');
    try {
      const ref = await insertNew(tx, householdId, draft);
      await tx.query('RELEASE SAVEPOINT proposal_insert');
      return ref;
    } catch (err) {
      await tx.query('ROLLBACK TO SAVEPOINT proposal_insert');
      // A concurrent propose for the same subject committed first: re-read and update it instead.
      if ((err as { code?: string }).code !== UNIQUE_VIOLATION) throw err;
    }
  }
  throw new PantryError('proposal_conflict', 'Another change to this card is in progress. Please try again.');
}

interface PendingRow {
  id: string;
  version: number;
  payload: unknown;
  preconditions: unknown;
  expires_at: Date;
}

/** Locks the pending proposal for a subject. An expired one is marked `expired` and ignored (§3.2, lazily). */
async function lockPendingSubject(tx: Tx, householdId: string, subjectKey: string): Promise<PendingRow | null> {
  const { rows } = await tx.query<PendingRow & { expired: boolean }>(
    `SELECT id, version, payload, preconditions, expires_at, expires_at <= now() AS expired
       FROM pantry.proposals
      WHERE household_id = $1 AND subject_key = $2 AND status = 'pending'
      FOR UPDATE`,
    [householdId, subjectKey],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.expired) {
    await tx.query(`UPDATE pantry.proposals SET status = 'expired', updated_at = now() WHERE id = $1`, [row.id]);
    return null;
  }
  return row;
}

async function updateExisting(tx: Tx, existing: PendingRow, draft: ProposalDraft): Promise<ProposalRef> {
  const same =
    canonicalJson(existing.payload) === canonicalJson(draft.payload) &&
    canonicalJson(existing.preconditions) === canonicalJson(draft.preconditions);
  if (same) {
    return {
      proposal_id: existing.id,
      version: existing.version,
      expires_at: iso(existing.expires_at),
      outcome: 'unchanged',
    };
  }

  const version = existing.version + 1;
  await insertVersion(tx, existing.id, version, draft);
  const { rows } = await tx.query<{ expires_at: Date }>(
    `UPDATE pantry.proposals
        SET version = $2, input = $3, payload = $4, preconditions = $5, updated_at = now(),
            expires_at = now() + make_interval(hours => $6)
      WHERE id = $1
      RETURNING expires_at`,
    [existing.id, version, json(draft.input), json(draft.payload), json(draft.preconditions), PROPOSAL_TTL_HOURS],
  );
  return { proposal_id: existing.id, version, expires_at: iso(rows[0]!.expires_at), outcome: 'new_version' };
}

async function insertNew(tx: Tx, householdId: string, draft: ProposalDraft): Promise<ProposalRef> {
  const id = randomUUID();
  const { rows } = await tx.query<{ expires_at: Date }>(
    `INSERT INTO pantry.proposals (id, household_id, conversation_id, kind, subject_key, target_session_id,
                                   target_operation_id, version, input, payload, preconditions, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9, $10, 'pending', now() + make_interval(hours => $11))
     RETURNING expires_at`,
    [
      id,
      householdId,
      draft.conversationId,
      draft.kind,
      draft.subjectKey,
      draft.targetSessionId ?? null,
      draft.targetOperationId ?? null,
      json(draft.input),
      json(draft.payload),
      json(draft.preconditions),
      PROPOSAL_TTL_HOURS,
    ],
  );
  await insertVersion(tx, id, 1, draft);
  return { proposal_id: id, version: 1, expires_at: iso(rows[0]!.expires_at), outcome: 'created' };
}

async function insertVersion(tx: Tx, proposalId: string, version: number, draft: ProposalDraft): Promise<void> {
  await tx.query(
    `INSERT INTO pantry.proposal_versions (proposal_id, version, payload, preconditions) VALUES ($1, $2, $3, $4)`,
    [proposalId, version, json(draft.payload), json(draft.preconditions)],
  );
}

const json = (value: unknown) => JSON.stringify(value);
const iso = (value: Date) => value.toISOString();

/** The current copy of the pending proposal for a subject, if any (no lock). */
export async function pendingProposal(
  tx: Tx,
  householdId: string,
  subjectKey: string,
): Promise<{ id: string; version: number; payload: unknown; preconditions: unknown } | null> {
  const { rows } = await tx.query<{ id: string; version: number; payload: unknown; preconditions: unknown }>(
    `SELECT id, version, payload, preconditions FROM pantry.proposals
      WHERE household_id = $1 AND subject_key = $2 AND status = 'pending' AND expires_at > now()`,
    [householdId, subjectKey],
  );
  return rows[0] ?? null;
}

export interface ProposalView {
  proposal_id: string;
  kind: ProposalKind;
  /** A pending card past its expiry reads as `expired`, though only an action marks it so. */
  status: 'pending' | 'committed' | 'rejected' | 'superseded' | 'stale' | 'expired';
  version: number;
  conversation_id: string;
  card: unknown;
  expires_at: string;
}

/** The current version of a proposal, as the card shows it (no lock). */
export async function proposalView(q: Queryable, proposalId: string): Promise<ProposalView | null> {
  const { rows } = await q.query<Omit<ProposalView, 'expires_at'> & { expires_at: Date }>(
    `SELECT id AS proposal_id, kind,
            CASE WHEN status = 'pending' AND expires_at <= now() THEN 'expired' ELSE status END AS status,
            version, conversation_id, payload -> 'card' AS card, expires_at
       FROM pantry.proposals WHERE id = $1`,
    [proposalId],
  );
  const row = rows[0];
  return row ? { ...row, expires_at: iso(row.expires_at) } : null;
}
