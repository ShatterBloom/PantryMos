// Speaks Mos's messages in order (IMPLEMENTATION_PLAN §8.5, §8.7). A message that asks something is
// acknowledged only once it has been heard to the end, which opens its voice window on the agent:
// a "yes" must never answer a read-back the user did not hear in full.

/** How an utterance ended: played to the end, or cut off (cancelled, or the browser failed). */
export type SpeechOutcome = 'completed' | 'interrupted';

/** The browser's speechSynthesis, reduced to one utterance at a time. */
export interface Synth {
  /** Calls `done` once the utterance ended. */
  speak(text: string, done: (outcome: SpeechOutcome) => void): void;
  cancel(): void;
}

export interface Spoken {
  id: number;
  speech: string;
  /** The message asked a question: ack it once heard (§8.5). */
  asks: boolean;
}

export class Speaker {
  private readonly queue: Spoken[] = [];
  private current: Spoken | null = null;
  /** Reported to onSpeaking: one stretch from the first message to the last queued one. */
  private reported = false;
  private muted = false;
  private readonly synth: Synth;
  private readonly onSpeaking: (speaking: boolean) => void;
  private readonly onHeard: (message: Spoken) => void;

  constructor(options: { synth: Synth; onSpeaking: (speaking: boolean) => void; onHeard: (message: Spoken) => void }) {
    this.synth = options.synth;
    this.onSpeaking = options.onSpeaking;
    this.onHeard = options.onHeard;
  }

  get speaking(): boolean {
    return this.current !== null;
  }

  enqueue(message: Spoken): void {
    if (message.speech.trim() === '' || this.muted) return;
    this.queue.push(message);
    this.next();
  }

  /**
   * Muted, messages are shown but not spoken, so none is heard: a question is answered by its
   * card's buttons, not by voice.
   */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.stop();
  }

  /** Stops speaking and drops what is queued (the user started talking, or left the page). */
  stop(): void {
    this.queue.length = 0;
    if (this.current) this.synth.cancel();
  }

  private next(): void {
    if (this.current) return;
    const message = this.queue.shift();
    if (!message) return;
    this.current = message;
    if (!this.reported) {
      this.reported = true;
      this.onSpeaking(true);
    }
    let finished = false;
    this.synth.speak(message.speech, (outcome) => {
      if (finished) return;
      finished = true;
      this.current = null;
      if (outcome === 'completed') this.onHeard(message);
      this.next();
      if (this.current === null && this.reported) {
        this.reported = false;
        this.onSpeaking(false);
      }
    });
  }
}
