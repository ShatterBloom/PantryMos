// Templated speech (IMPLEMENTATION_PLAN §8.5, §8.6): everything the app says without the model.
import type { AppEvent } from '../store/events.ts';

export const duration = (seconds: number) => {
  if (seconds % 60 !== 0) return `${seconds} seconds`;
  const m = seconds / 60;
  return `${m} minute${m === 1 ? '' : 's'}`;
};

/** §8.6: the offer appended after a step that has a duration. */
export const timerOffer = (seconds: number) => `This step takes ${duration(seconds)} — start a timer?`;

export const TIMER_DECLINED = "OK — say 'Mos, start the timer' when you're ready.";
export const timerStarted = (seconds: number) => `Timer started: ${duration(seconds)}.`;

const DONE: Record<string, string> = {
  intake: 'Done — added to your stock.',
  consume: 'Done — recorded what you used.',
  revise_consumption: 'Done — the meal is corrected.',
  adjust: 'Done — the stock is updated.',
  undo: 'Done — that is undone.',
};
/** §8.5 step 3: the templated result of a voice confirmation. */
export const confirmed = (kind: string) => DONE[kind] ?? 'Done.';
export const DISCARDED = 'OK, I discarded that card.';
export const cardChanged = (readback: string) => `That card changed. Here's the updated one: ${readback}`;
export const cardExpired = 'That card expired. Please ask again.';
export const ALREADY_SAVED = 'That card was already saved.';
export const TURN_FAILED = "Sorry, I couldn't finish that. Please try again.";

/** The `[app event]` block the model reads for an event (§8.2). */
export function eventBlock(e: Pick<AppEvent, 'kind' | 'payload'>): string {
  const p = e.payload as Record<string, string | number | null | undefined>;
  switch (e.kind) {
    case 'timer_fired':
      return `[app event] timer "${p.label}" finished${p.step_no ? ` (recipe step ${p.step_no})` : ''}.`;
    case 'proposal_committed':
      return `[app event] proposal ${p.proposal_id} v${p.version} (${p.kind}) committed.`;
    case 'proposal_stale':
      return `[app event] proposal ${p.proposal_id} v${p.version} (${p.kind}) was not committed: things changed since it was made (${p.reason}).`;
    case 'proposal_rejected':
      return `[app event] proposal ${p.proposal_id} v${p.version} (${p.kind}) was discarded by the user.`;
    case 'window_expired':
      return `[app event] the user said "${p.utterance}" after the confirmation window closed; the app read the card again.`;
  }
}

/** §8.6: what is said when a proactive turn keeps failing, so the user is never left uninformed. */
export function fallbackSpeech(e: Pick<AppEvent, 'kind' | 'payload'>): string {
  const p = e.payload as Record<string, string | number | null | undefined>;
  switch (e.kind) {
    case 'timer_fired':
      return `Timer '${p.label}' is done.`;
    case 'proposal_committed':
      return confirmed(String(p.kind));
    case 'proposal_stale':
      return 'That card changed before it was saved. Ask me to refresh it.';
    case 'proposal_rejected':
      return DISCARDED;
    case 'window_expired':
      return 'Say confirm when you are ready.';
  }
}
