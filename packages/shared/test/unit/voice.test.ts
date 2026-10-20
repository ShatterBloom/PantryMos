// The ConfirmGate's phrase lists (§8.5), shared by the agent and the web app.
import { describe, expect, it } from 'vitest';
import { ACCEPT, CONFIRM, DECLINE, DISCARD, normalizeUtterance } from '../../src/voice.ts';

describe('normalizeUtterance (§8.5 step 1)', () => {
  it('lowercases, strips punctuation and the wake word, and collapses spaces', () => {
    expect(normalizeUtterance('  Mos,   YES please!  ')).toBe('yes please');
    expect(normalizeUtterance('That’s right.')).toBe("that's right");
    expect(normalizeUtterance('mos')).toBe('');
    expect(normalizeUtterance('Mostly yes')).toBe('mostly yes');
  });

  it('keeps "no" out of the card lists but lets it decline a timer', () => {
    expect(CONFIRM.has('no') || DISCARD.has('no')).toBe(false);
    expect(DECLINE.has('no')).toBe(true);
    for (const phrase of CONFIRM) expect(ACCEPT.has(phrase)).toBe(true);
  });
});
