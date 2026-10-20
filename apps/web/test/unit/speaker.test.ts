// Speaking messages in order, reporting when each has been heard (§8.5 read-back ack, §8.7 echo control).
import { beforeEach, describe, expect, it } from 'vitest';
import { Speaker, type Spoken, type Synth } from '../../src/lib/speaker.ts';

class FakeSynth implements Synth {
  said: string[] = [];
  cancels = 0;
  private pending: Array<() => void> = [];
  speak(text: string, done: () => void) {
    this.said.push(text);
    this.pending.push(done);
  }
  cancel() {
    this.cancels++;
    this.finish();
  }
  /** The current utterance ends (its callback may fire twice, as browsers do on cancel). */
  finish() {
    const done = this.pending.shift();
    done?.();
    done?.();
  }
}

describe('Speaker', () => {
  let synth: FakeSynth;
  let speaking: boolean[];
  let spoken: Spoken[];
  let speaker: Speaker;
  beforeEach(() => {
    synth = new FakeSynth();
    speaking = [];
    spoken = [];
    speaker = new Speaker({ synth, onSpeaking: (s) => speaking.push(s), onSpoken: (m) => spoken.push(m) });
  });

  const msg = (id: number, speech: string, asks = false): Spoken => ({ id, speech, asks });

  it('speaks one message at a time, in order, and reports each once heard', () => {
    speaker.enqueue(msg(1, 'Step 1.'));
    speaker.enqueue(msg(2, "I'll record that. Say confirm.", true));
    expect(synth.said).toEqual(['Step 1.']);
    expect(speaker.speaking).toBe(true);
    synth.finish();
    expect(synth.said).toEqual(['Step 1.', "I'll record that. Say confirm."]);
    expect(spoken.map((m) => m.id)).toEqual([1]);
    synth.finish();
    expect(spoken).toEqual([msg(1, 'Step 1.'), msg(2, "I'll record that. Say confirm.", true)]);
    // Speaking is reported as one stretch, so listening does not resume between messages.
    expect(speaking).toEqual([true, false]);
    expect(speaker.speaking).toBe(false);
  });

  it('skips empty speech', () => {
    speaker.enqueue(msg(1, '  '));
    expect(synth.said).toEqual([]);
    expect(spoken).toEqual([]);
  });

  it('muted, delivers without speaking, so a question can still be answered', () => {
    speaker.enqueue(msg(1, 'A long answer.'));
    speaker.enqueue(msg(4, 'Queued behind it.'));
    speaker.setMuted(true); // cuts the current message short
    expect(synth.cancels).toBe(1);
    speaker.enqueue(msg(2, 'Say confirm.', true));
    expect(synth.said).toEqual(['A long answer.']);
    expect(spoken.map((m) => m.id)).toEqual([1, 4, 2]);
    expect(speaking).toEqual([true, false]); // listening may resume
    speaker.setMuted(false);
    speaker.enqueue(msg(3, 'Back.'));
    expect(synth.said.at(-1)).toBe('Back.');
  });

  it('stops and drops what is queued', () => {
    speaker.enqueue(msg(1, 'One.'));
    speaker.enqueue(msg(2, 'Two.'));
    speaker.stop();
    expect(synth.said).toEqual(['One.']);
    expect(speaker.speaking).toBe(false);
    speaker.stop(); // nothing to stop
    expect(synth.cancels).toBe(1);
  });
});
