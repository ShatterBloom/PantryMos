// The card a proposal shows and reads back (PRD FR-3, FR-33): rendered from the plan, never by the model.
export interface Card {
  title: string;
  lines: string[];
  warnings: string[];
  readback_text: string;
}

/** Ends every read-back; the ConfirmGate then listens for an exact short phrase (§8.5). */
export const CONFIRM_PROMPT = 'Say confirm, or tell me what to change.';
