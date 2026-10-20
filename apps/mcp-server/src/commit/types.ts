import type { ProposalKind } from '../db/proposals.ts';
import type { Tx } from '../db/tx.ts';

/** The locked proposal row a confirm executes. */
export interface LockedProposal {
  id: string;
  household_id: string;
  conversation_id: string;
  kind: ProposalKind;
  version: number;
  status: string;
  payload: unknown;
  preconditions: unknown;
  target_session_id: string | null;
  expired: boolean;
}

/** Per-kind commit logic. Confirm never re-plans: it executes the pinned plan or reports it stale (§4.2). */
export interface Executor {
  /**
   * Locks the business state the plan depends on, in the fixed order of §4.3 step 3, and re-checks
   * every precondition under those locks. Returns the stale reason, or null if the plan still holds.
   */
  lockAndCheck(tx: Tx, proposal: LockedProposal): Promise<string | null>;
  /** The ledger summary stored on the operation and returned to the caller. */
  summary(proposal: LockedProposal): Record<string, unknown>;
  /** Applies the pinned plan. The operation row already exists. */
  execute(tx: Tx, proposal: LockedProposal, operationId: string): Promise<void>;
}
