/** Business error codes returned with `isError: true` (IMPLEMENTATION_PLAN §7.1). */
export const ERROR_CODES = [
  'request_id_required',
  'conversation_id_required',
  'request_conflict',
  'needs_clarification',
  'unknown_item',
  'ambiguous_item',
  'unit_mismatch',
  'invalid_date',
  'invalid_quantity',
  'insufficient_stock',
  'no_active_session',
  'session_in_progress',
  'invalid_state',
  'step_conflict',
  'unknown_recipe',
  'no_substitute',
  'not_in_plan',
  'invalid_substitution',
  'substitution_required',
  'no_completed_session',
  'ambiguous_session',
  'ambiguous_batch',
  'ambiguous_undo',
  'has_dependents',
  'already_reverted',
  'not_undoable',
  'would_go_negative',
  'proposal_conflict',
  'rate_limited',
  // Internal confirm/commit outcomes (§4.3).
  'not_found',
  'already_committed',
  'not_pending',
  'stale_proposal',
  'stale_state',
  'expired',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Error body shared by MCP tool results and internal routes. Extra keys carry code-specific details. */
export interface BusinessError {
  code: ErrorCode;
  message: string;
  ask?: string;
  options?: unknown[];
  required?: string[];
  [detail: string]: unknown;
}
