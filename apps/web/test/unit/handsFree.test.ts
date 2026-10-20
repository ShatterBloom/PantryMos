// §8.7 hands-free listening: restarts with backoff, echo control, auto-off, and a refused microphone.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AUTO_OFF_MS,
  ECHO_GUARD_MS,
  HandsFreeController,
  type HandsFreeState,
  type Recognizer,
  RESTART_MAX_MS,
  RESTART_MIN_MS,
} from '../../src/lib/handsFree.ts';

/** A clock the test advances by hand. */
class FakeClock {
  now = 0;
  private timers: Array<{ at: number; fn: () => void; id: number }> = [];
  private seq = 0;
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.timers.push({ at: this.now + ms, fn, id });
    return id;
  };
  clearTimeout = (id: unknown) => {
    this.timers = this.timers.filter((t) => t.id !== id);
  };
  advance(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.now = due.at;
      due.fn();
    }
    this.now = until;
  }
}

class FakeRecognizer implements Recognizer {
  starts = 0;
  running = false;
  throwOnStart = false;
  onResult: ((t: string) => void) | null = null;
  onEnd: (() => void) | null = null;
  onError: ((e: string) => void) | null = null;
  start() {
    if (this.throwOnStart) throw new Error('InvalidStateError');
    this.starts++;
    this.running = true;
  }
  stop() {
    if (!this.running) return;
    this.running = false;
    this.onEnd?.();
  }
  /** The browser ends recognition by itself (silence, a network blip). */
  end() {
    this.running = false;
    this.onEnd?.();
  }
}

describe('HandsFreeController', () => {
  let clock: FakeClock;
  let recognizer: FakeRecognizer;
  let heard: string[];
  let states: HandsFreeState[];
  let controller: HandsFreeController;
  beforeEach(() => {
    clock = new FakeClock();
    recognizer = new FakeRecognizer();
    heard = [];
    states = [];
    controller = new HandsFreeController({ recognizer, clock, onUtterance: (t) => heard.push(t), onChange: (s) => states.push(s) });
  });

  it('listens once enabled and passes on what it hears', () => {
    controller.enable();
    controller.enable(); // already on
    expect(recognizer.starts).toBe(1);
    expect(controller.state).toEqual({ enabled: true, listening: true, error: null });
    recognizer.onResult?.('mos next');
    expect(heard).toEqual(['mos next']);
  });

  it('restarts after it ends, backing off 0.5 s → 5 s until it hears something', () => {
    controller.enable();
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      recognizer.end();
      const before = clock.now;
      const starts = recognizer.starts;
      while (recognizer.starts === starts) clock.advance(100);
      delays.push(clock.now - before);
    }
    expect(delays).toEqual([RESTART_MIN_MS, 1000, 2000, 4000, RESTART_MAX_MS, RESTART_MAX_MS]);

    recognizer.onResult?.('mos hello'); // it works again: the next restart is quick
    recognizer.end();
    clock.advance(RESTART_MIN_MS);
    expect(recognizer.running).toBe(true);
  });

  it('does not listen while Mos speaks, nor just after', () => {
    controller.enable();
    controller.setSpeaking(true);
    expect(recognizer.running).toBe(false);
    clock.advance(10_000); // no restart while speaking
    expect(recognizer.running).toBe(false);
    recognizer.onResult?.('stale result'); // a result that arrives late is dropped
    expect(heard).toEqual([]);

    controller.setSpeaking(false);
    clock.advance(ECHO_GUARD_MS - 1);
    expect(recognizer.running).toBe(false);
    clock.advance(1);
    expect(recognizer.running).toBe(true);
    controller.setSpeaking(false); // no change
    expect(recognizer.starts).toBe(2);
  });

  it('stays off when disabled, and speaking does not turn it on', () => {
    controller.setSpeaking(true);
    controller.setSpeaking(false);
    clock.advance(1000);
    expect(recognizer.starts).toBe(0);
    controller.enable();
    controller.disable();
    clock.advance(10_000);
    expect(recognizer.running).toBe(false);
    expect(states.at(-1)).toEqual({ enabled: false, listening: false, error: null });
  });

  it('turns off two minutes after the meal is recorded, unless cooking starts again', () => {
    controller.sessionEnded(); // not on: nothing to turn off
    controller.sessionStarted();
    controller.sessionEnded();
    clock.advance(AUTO_OFF_MS - 1);
    expect(controller.state.enabled).toBe(true);
    controller.sessionStarted(); // a new session keeps it on
    clock.advance(AUTO_OFF_MS);
    expect(controller.state.enabled).toBe(true);

    controller.sessionEnded();
    controller.sessionEnded(); // the later end restarts the countdown
    clock.advance(AUTO_OFF_MS);
    expect(controller.state.enabled).toBe(false);
  });

  it('gives up on a refused microphone, but rides out other errors', () => {
    controller.enable();
    recognizer.onError?.('no-speech');
    recognizer.end();
    clock.advance(RESTART_MIN_MS);
    expect(recognizer.running).toBe(true);

    recognizer.onError?.('not-allowed');
    expect(controller.state).toEqual({ enabled: false, listening: false, error: 'not-allowed' });
    controller.enable(); // the user allowed it and tries again
    expect(controller.state.error).toBeNull();
  });

  it('survives a start the browser refuses because recognition is still starting', () => {
    recognizer.throwOnStart = true;
    expect(() => controller.enable()).not.toThrow();
    expect(controller.state.listening).toBe(true);
    recognizer.throwOnStart = false;
    recognizer.end();
    clock.advance(RESTART_MIN_MS);
    expect(recognizer.starts).toBe(1);
  });
});
