// Undo proposals (IMPLEMENTATION_PLAN §4.2, §6.6, §7.4 propose_undo).
import { z } from 'zod';
import { householdToday } from '../db/catalog.ts';
import { batchesByIds, type BatchView } from '../db/inventory.ts';
import {
  lastUndoable,
  liveEventsOfOperation,
  liveMealOperations,
  liveEventsOfSession,
  liveRevisions,
  type OperationHead,
  operationById,
} from '../db/operations.ts';
import { type ProposalRef, upsertProposal } from '../db/proposals.ts';
import { findSession, itemInfo, type SessionRow } from '../db/sessions.ts';
import type { Tx } from '../db/tx.ts';
import { type Card, CONFIRM_PROMPT } from '../domain/card.ts';
import { PantryError } from '../domain/errors.ts';
import { checkNotNegative, defaultScope, describeReversal, type ItemChange, netChanges, type Reversal, reversalsOf, type UndoScope } from '../domain/undo.ts';
import { speakQuantity } from '../domain/speech.ts';
import { roundQuantity } from '../domain/units.ts';

export const UndoInputShape = {
  target: z
    .union([z.literal('last'), z.uuid()])
    .describe('"last" for the most recent change, an operation_id / session_id from list_recent_operations, or the proposal_id of a confirmed card.'),
  scope: z.enum(['operation', 'session']).optional().describe('"session" undoes a whole meal; "operation" one change.'),
};
export const UndoInput = z.object(UndoInputShape);
export type UndoInput = z.infer<typeof UndoInput>;

export interface UndoPayload {
  scope: UndoScope;
  /** The operation (scope operation) or session (scope session) being undone. */
  target: string;
  reversals: Reversal[];
  /** The net stock change per item, for the commit summary. */
  changes: ItemChange[];
  /** Operations reverted once this commits; one may have no events (a meal that took no stock). */
  reverted_operations: string[];
  card: Card;
}

export interface UndoPreconditions {
  events_not_reverted: string[];
  batches: Array<{ id: string; version: number }>;
  session?: { id: string; state: string; state_version: number };
}

interface Resolved {
  scope: UndoScope;
  operation: OperationHead | null;
  session: SessionRow | null;
}

/**
 * Proposes undoing a committed change (§7.4 propose_undo): every live event of the operation, or
 * every live consume and revision event of a meal, reversed. A meal that took no stock has none,
 * and undoing it only reverts the session. Inventory is unchanged until the card is confirmed.
 */
export async function proposeUndo(
  tx: Tx,
  householdId: string,
  conversationId: string,
  input: UndoInput,
): Promise<ProposalRef & { card: Card; scope: UndoScope; target: string }> {
  const resolved = await resolveTarget(tx, householdId, input);
  const { scope, operation, session } = resolved;
  const target = scope === 'session' ? session!.id : operation!.id;

  // Already-undone targets were refused while resolving, so no events here means none were written.
  const events = scope === 'session' ? await liveEventsOfSession(tx, session!.id) : await liveEventsOfOperation(tx, operation!.id);
  const reversals = reversalsOf(events);

  const today = await householdToday(tx, householdId);
  const batches = await batchesByIds(tx, householdId, [...new Set(reversals.map((r) => r.batch_id))], today);
  checkNotNegative(reversals, new Map(batches.map((b) => [b.batch_id, { quantity: b.quantity, item: b.item, unit: b.unit }])));

  const changes = netChanges(reversals, await itemInfo(tx, householdId));
  const payload: UndoPayload = {
    scope,
    target,
    reversals,
    changes,
    reverted_operations: scope === 'session' ? await liveMealOperations(tx, session!.id) : [operation!.id],
    card: renderCard(resolved, reversals, changes, batches),
  };
  const preconditions: UndoPreconditions = {
    events_not_reverted: reversals.map((r) => r.reverts_event_id).sort(),
    batches: batches.map((b) => ({ id: b.batch_id, version: b.version })),
    ...(session ? { session: { id: session.id, state: session.state, state_version: session.state_version } } : {}),
  };
  const ref = await upsertProposal(tx, householdId, {
    kind: 'undo',
    subjectKey: scope === 'session' ? `undo:session:${target}` : `undo:op:${target}`,
    conversationId,
    ...(session ? { targetSessionId: session.id } : {}),
    ...(operation && scope === 'operation' ? { targetOperationId: operation.id } : {}),
    // Edits and Refresh re-plan this exact target, never a later "last".
    input: { target, scope },
    payload,
    preconditions,
  });
  return { ...ref, card: payload.card, scope, target };
}

/** §6.6: the operation or meal to undo, and the scope, with the session locked when there is one. */
async function resolveTarget(tx: Tx, householdId: string, input: UndoInput): Promise<Resolved> {
  let operation: OperationHead | null;
  if (input.target === 'last') {
    operation = await lastUndoable(tx, householdId);
    if (!operation) throw new PantryError('not_undoable', 'There is nothing to undo.');
  } else {
    operation = await operationById(tx, householdId, input.target);
    if (!operation) {
      // Not an operation: a meal's session id.
      if (input.scope === 'operation') throw new PantryError('not_found', 'There is no such change to undo.');
      return { scope: 'session', operation: null, session: await lockMeal(tx, householdId, input.target) };
    }
    if (operation.kind === 'undo') throw new PantryError('not_undoable', 'An undo cannot itself be undone; make the change again instead.');
    if (operation.reverted) throw alreadyReverted('That change');
  }

  let scope = input.scope ?? defaultScope(operation, input.target === 'last');
  if (scope === 'session' && operation.session_id === null) {
    throw new PantryError('not_undoable', 'That change is not part of a meal.', { options: ['undo just this change'] });
  }
  if (scope === 'operation' && operation.kind === 'consume') {
    // The meal's corrections depend on its consumption: undo them first, or the whole meal.
    const dependents = await liveRevisions(tx, operation.session_id!);
    if (dependents.length > 0) {
      throw new PantryError('has_dependents', 'That meal was corrected afterwards.', {
        ask: 'Undo the whole meal, including the corrections?',
        options: [{ scope: 'session', target: operation.session_id, label: 'undo the whole meal' }],
      });
    }
    scope = 'session'; // with no corrections, undoing the consume is undoing the meal
  }
  const session = operation.session_id === null ? null : await lockMeal(tx, householdId, operation.session_id);
  return { scope, operation, session };
}

/** Locks a meal for undo; it must be consumed (a reverted one is already undone). */
async function lockMeal(tx: Tx, householdId: string, sessionId: string): Promise<SessionRow> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM pantry.cooking_sessions WHERE household_id = $1 AND id = $2 FOR UPDATE`,
    [householdId, sessionId],
  );
  if (!rows[0]) throw new PantryError('not_found', 'There is no such change or meal to undo.');
  const session = (await findSession(tx, householdId, sessionId))!;
  if (session.state === 'reverted') throw alreadyReverted('That meal');
  if (session.state !== 'consumed') {
    throw new PantryError('invalid_state', `That meal is ${session.state}, so there is nothing recorded to undo.`, {
      state: session.state,
    });
  }
  return session;
}

const alreadyReverted = (what: string) => new PantryError('already_reverted', `${what} was already undone.`);

function renderCard(
  { scope, operation, session }: Resolved,
  reversals: readonly Reversal[],
  changes: readonly ItemChange[],
  batches: readonly BatchView[],
): Card {
  const what =
    scope === 'session'
      ? `the whole ${session!.recipe} meal`
      : operation!.kind === 'revise_consumption'
        ? `the correction to ${operation!.recipe}`
        : operation!.kind === 'intake'
          ? 'the groceries added'
          : 'the stock adjustment';
  const perBatch = new Map<string, number>();
  for (const r of reversals) perBatch.set(r.batch_id, roundQuantity((perBatch.get(r.batch_id) ?? 0) + r.delta));
  const lines = [...perBatch]
    .filter(([, delta]) => delta !== 0)
    .map(([batchId, delta]) => {
      const b = batches.find((x) => x.batch_id === batchId)!;
      return `${delta > 0 ? '+' : '−'}${speakQuantity(b.item, Math.abs(delta), b.unit, b.unit)} · ${b.date_label}`;
    });
  return {
    title: `Undo ${what}`,
    lines,
    warnings: [],
    readback_text: `I'll undo ${what}, ${describeReversal(changes)}. ${CONFIRM_PROMPT}`,
  };
}
