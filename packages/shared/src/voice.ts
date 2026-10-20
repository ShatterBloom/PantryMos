// The ConfirmGate's phrase lists (IMPLEMENTATION_PLAN §8.5), shared with the web app, which sends a
// bare phrase without the wake word only while a window is open (§8.7). Browser-safe: no Node imports.

export const CONFIRM: ReadonlySet<string> = new Set([
  'yes',
  'yes please',
  'yeah',
  'yep',
  'confirm',
  'confirmed',
  'correct',
  "that's right",
  'that is right',
  'do it',
  'sounds good',
]);
export const DISCARD: ReadonlySet<string> = new Set(['cancel', 'discard', 'never mind', 'scrap that']);
export const ACCEPT: ReadonlySet<string> = new Set([...CONFIRM, 'start', 'start it', 'start the timer', 'sure', 'ok', 'okay']);
export const DECLINE: ReadonlySet<string> = new Set(['no', 'no thanks', 'not yet', 'later', 'skip']);

/** §8.5 step 1: lowercase, no punctuation (apostrophes kept), single spaces, no leading wake word. */
export function normalizeUtterance(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^mos\b ?/, '');
}
