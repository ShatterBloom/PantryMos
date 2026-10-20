// §8.7 Addressing: the wake word, client commands, and bare phrases inside a voice window.
import { describe, expect, it } from 'vitest';
import { address } from '../../src/lib/addressing.ts';

describe('address', () => {
  it('sends what follows the wake word, however the recognizer spelled it', () => {
    expect(address('Mos, what is expiring soon?', null)).toEqual({ kind: 'send', text: 'what is expiring soon' });
    expect(address('moss next', null)).toEqual({ kind: 'send', text: 'next' });
    expect(address('Most, I spilled the milk', null)).toEqual({ kind: 'send', text: 'i spilled the milk' });
    expect(address('Mouse, start a timer for 5 minutes', null)).toEqual({ kind: 'send', text: 'start a timer for 5 minutes' });
    expect(address("Mos, that's right", 'proposal_confirm')).toEqual({ kind: 'send', text: "that's right" });
  });

  it('ignores the wake word alone and speech not meant for Mos', () => {
    expect(address('Mos', null)).toEqual({ kind: 'ignore' });
    expect(address('mostly done here', null)).toEqual({ kind: 'ignore' });
    expect(address('can you pass the salt', null)).toEqual({ kind: 'ignore' });
    expect(address('', null)).toEqual({ kind: 'ignore' });
  });

  it('handles hands-free commands on the client', () => {
    expect(address('Mos, hands-free on', null)).toEqual({ kind: 'command', command: 'hands_free_on' });
    expect(address('mos hands free', null)).toEqual({ kind: 'command', command: 'hands_free_on' });
    expect(address('Mos, stop listening.', null)).toEqual({ kind: 'command', command: 'stop_listening' });
  });

  it("sends a bare phrase only from the open window's lists", () => {
    expect(address('Yes.', 'proposal_confirm')).toEqual({ kind: 'send', text: 'yes' });
    expect(address('Scrap that!', 'proposal_confirm')).toEqual({ kind: 'send', text: 'scrap that' });
    // "no" is not a card answer (it often starts a correction), but it declines a timer.
    expect(address('no', 'proposal_confirm')).toEqual({ kind: 'ignore' });
    expect(address('no thanks', 'timer_offer')).toEqual({ kind: 'send', text: 'no thanks' });
    expect(address('Start the timer', 'timer_offer')).toEqual({ kind: 'send', text: 'start the timer' });
    expect(address('start the timer', 'proposal_confirm')).toEqual({ kind: 'ignore' });
    expect(address('yes', null)).toEqual({ kind: 'ignore' });
    expect(address('yes but three eggs', 'proposal_confirm')).toEqual({ kind: 'ignore' });
  });
});
