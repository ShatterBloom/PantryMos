// Speaking messages in order; only a message heard to the end counts as heard (§8.5 read-back ack, §8.7).
import { beforeEach, describe, expect, it } from 'vitest';
import { Speaker, type SpeechOutcome, type Spoken, type Synth } from '../../src/lib/speaker.ts';

class FakeSynth implements Synth {
  said: string[] = [];
  cancels = 0;
  private pending: Array<(outcome: SpeechOutcome) => void> = [];
  speak(text: string, done: (outcome: SpeechOutcome) => void) {
    this.said.push(text);
    this.pending.push(done);
  }
  cancel() {
    this.cancels++;
    this.finish('interrupted');
  }
  /** The current utterance ends (browsers may report it twice, e.g. error then end on cancel). */
  finish(outcome: SpeechOutcome = 'completed') {
    const done = this.pending.shift();
    done?.(outcome);
    done?.('completed');
  }
}

describe('Speaker', () => {
  let synth: FakeSynth;
  let speaking: boolean[];
  let heard: Spoken[];
  let speaker: Speaker;
  beforeEach(() => {
    synth = new FakeSynth();
    speaking = [];
    heard = [];
    speaker = new Speaker({ synth, onSpeaking: (s) => speaking.push(s), onHeard: (m) => heard.push(m) });
  });

  const msg = (id: number, speech: string, asks = false): Spoken => ({ id, speech, asks });

  it('speaks one message at a time, in order, and reports each once heard to the end', () => {
    speaker.enqueue(msg(1, 'Step 1.'));
    speaker.enqueue(msg(2, "I'll record that. Say confirm.", true));
    expect(synth.said).toEqual(['Step 1.']);
    expect(speaker.speaking).toBe(true);
    synth.finish();
    expect(synth.said).toEqual(['Step 1.', "I'll record that. Say confirm."]);
    expect(heard.map((m) => m.id)).toEqual([1]);
    synth.finish();
    expect(heard).toEqual([msg(1, 'Step 1.'), msg(2, "I'll record that. Say confirm.", true)]);
    // Speaking is reported as one stretch, so listening does not resume between messages.
    expect(speaking).toEqual([true, false]);
    expect(speaker.speaking).toBe(false);
  });

  it('does not count a message cut off or failed as heard', () => {
    speaker.enqueue(msg(1, "I'll record that. Say confirm.", true));
    speaker.stop(); // the user pressed push-to-talk
    expect(heard).toEqual([]);
    expect(speaking).toEqual([true, false]);

    speaker.enqueue(msg(2, 'Say confirm.', true));
    synth.finish('interrupted'); // the browser failed to speak it
    expect(heard).toEqual([]);
  });

  it('skips empty speech', () => {
    speaker.enqueue(msg(1, '  '));
    expect(synth.said).toEqual([]);
    expect(heard).toEqual([]);
  });

  it('muted, speaks nothing and hears nothing, so questions are answered by buttons', () => {
    speaker.enqueue(msg(1, 'A long answer.'));
    speaker.enqueue(msg(4, 'Queued behind it.'));
    speaker.setMuted(true); // cuts the current message short and drops the queue
    expect(synth.cancels).toBe(1);
    speaker.enqueue(msg(2, 'Say confirm.', true));
    expect(synth.said).toEqual(['A long answer.']);
    expect(heard).toEqual([]);
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
