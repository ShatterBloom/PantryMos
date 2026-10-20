// Which recognized utterances are meant for Mos (IMPLEMENTATION_PLAN §8.7 Addressing).
import { ACCEPT, CONFIRM, DECLINE, DISCARD, normalizeUtterance } from '@pantrymos/shared/voice';

/** Recognizers often hear "Mos" as one of these. */
export const WAKE_WORDS: ReadonlySet<string> = new Set(['mos', 'moss', 'most', 'mouse']);

/** The kind of the open voice window, if any (§8.5): it decides which bare phrases count. */
export type WindowKind = 'proposal_confirm' | 'timer_offer';

export type Addressed =
  | { kind: 'send'; text: string }
  | { kind: 'command'; command: 'hands_free_on' | 'stop_listening' }
  | { kind: 'ignore' };

const COMMANDS: Record<string, 'hands_free_on' | 'stop_listening'> = {
  'hands free on': 'hands_free_on',
  'hands free': 'hands_free_on',
  'stop listening': 'stop_listening',
};

/**
 * "Mos, …" is sent without the wake word; a client command ("Mos, stop listening") is handled
 * here. Without the wake word, only a bare phrase of the open window's lists is sent; anything
 * else (kitchen chatter) is ignored.
 */
export function address(transcript: string, window: WindowKind | null): Addressed {
  const words = transcript
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length > 0 && WAKE_WORDS.has(words[0]!)) {
    const rest = words.slice(1).join(' ');
    if (rest === '') return { kind: 'ignore' };
    const command = COMMANDS[rest];
    return command ? { kind: 'command', command } : { kind: 'send', text: rest };
  }
  const phrase = normalizeUtterance(transcript);
  if (window === 'proposal_confirm' && (CONFIRM.has(phrase) || DISCARD.has(phrase))) return { kind: 'send', text: phrase };
  if (window === 'timer_offer' && (ACCEPT.has(phrase) || DECLINE.has(phrase))) return { kind: 'send', text: phrase };
  return { kind: 'ignore' };
}
