// What edit and regenerate need from each proposal kind (§4.4): how the user's card changes merge
// into the stored input, and how to propose again from an input.
import { z } from 'zod';
import type { ProposalKind, ProposalRef } from '../db/proposals.ts';
import type { Tx } from '../db/tx.ts';
import type { Card } from '../domain/card.ts';
import { AdjustInput, proposeAdjustment } from './adjust.ts';
import { type ConsumeInput, ConsumeOverrides, mergeOverrides, proposeConsumption } from './consume.ts';
import { type IntakeInput, IntakeItems, proposeIntake } from './intake.ts';
import { proposeRevision, type ReviseInput, RevisionUsage } from './revise.ts';
import { proposeUndo, UndoInput } from './undo.ts';

export interface Planner {
  /** Schema of the `changes` a card edit may send for this kind. */
  Changes: z.ZodType;
  merge(input: unknown, changes: unknown): unknown;
  propose(tx: Tx, householdId: string, conversationId: string, input: unknown): Promise<ProposalRef & { card: Card }>;
}

export const PLANNERS: Record<ProposalKind, Planner> = {
  intake: {
    // The app sends the full edited item list.
    Changes: z.object({ items: IntakeItems }),
    merge: (_input, changes) => ({ items: (changes as IntakeInput).items }),
    propose: (tx, householdId, conversationId, input) => proposeIntake(tx, householdId, conversationId, input as IntakeInput),
  },
  consume: {
    // The app sends the lines the user changed; others keep their amounts.
    Changes: z.object({ overrides: ConsumeOverrides }),
    merge: (input, changes) => {
      const stored = input as ConsumeInput;
      return {
        session_id: stored.session_id,
        overrides: mergeOverrides(stored.overrides ?? [], (changes as { overrides: ConsumeInput['overrides'] }).overrides ?? []),
      };
    },
    propose: (tx, householdId, conversationId, input) =>
      proposeConsumption(tx, householdId, conversationId, input as ConsumeInput),
  },
  revise_consumption: {
    // Like consume: the changed items only; a later amount for an item replaces the earlier one.
    Changes: z.object({ usage: RevisionUsage }),
    merge: (input, changes) => {
      const stored = input as ReviseInput;
      return { session_id: stored.session_id, usage: mergeOverrides(stored.usage, (changes as ReviseInput).usage) };
    },
    propose: (tx, householdId, conversationId, input) => proposeRevision(tx, householdId, conversationId, input as ReviseInput),
  },
  adjust: {
    // The app edits the amount: a new delta or counted quantity replaces the old one, or the share.
    Changes: AdjustInput.pick({ delta: true, set_quantity: true }),
    merge: (input, changes) => {
      const { delta: _delta, set_quantity: _set, share: _share, ...rest } = input as AdjustInput;
      return { ...rest, ...(changes as Pick<AdjustInput, 'delta' | 'set_quantity'>) };
    },
    propose: (tx, householdId, conversationId, input) => proposeAdjustment(tx, householdId, conversationId, input as AdjustInput),
  },
  undo: {
    // An undo card has nothing to edit; Refresh re-plans the stored target.
    Changes: z.never(),
    merge: (input) => input,
    propose: (tx, householdId, conversationId, input) => proposeUndo(tx, householdId, conversationId, input as UndoInput),
  },
};
