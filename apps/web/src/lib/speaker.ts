// Speaks Mos's messages in order (IMPLEMENTATION_PLAN §8.5, §8.7). A message that asks something is
// acknowledged once it has been spoken, which opens its voice window on the agent.

/** The browser's speechSynthesis, reduced to one utterance at a time. */
export interface Synth {
  /** Calls `done` when the utterance ended or failed. */
  speak(text: string, done: () => void): void;
  cancel(): void;
}

export interface Spoken {
  id: number;
  speech: string;
  /** The message asked a question: ack it once spoken (§8.5). */
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
  private readonly onSpoken: (message: Spoken) => void;

  constructor(options: { synth: Synth; onSpeaking: (speaking: boolean) => void; onSpoken: (message: Spoken) => void }) {
    this.synth = options.synth;
    this.onSpeaking = options.onSpeaking;
    this.onSpoken = options.onSpoken;
  }

  get speaking(): boolean {
    return this.current !== null;
  }

  enqueue(message: Spoken): void {
    if (message.speech.trim() === '') return;
    this.queue.push(message);
    this.next();
  }

  /**
   * Muted, messages are not spoken but still count as delivered: one that asks is acknowledged
   * right away, so the user can answer by voice or button as if they had heard it.
   */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted && this.current) this.synth.cancel();
  }

  /** Stops speaking and drops what is queued (e.g. leaving the page). */
  stop(): void {
    this.queue.length = 0;
    if (this.current) this.synth.cancel();
  }

  private next(): void {
    if (this.current) return;
    const message = this.queue.shift();
    if (!message) return;
    if (this.muted) {
      this.onSpoken(message);
      this.next();
      return;
    }
    this.current = message;
    if (!this.reported) {
      this.reported = true;
      this.onSpeaking(true);
    }
    let finished = false;
    this.synth.speak(message.speech, () => {
      if (finished) return;
      finished = true;
      this.current = null;
      this.onSpoken(message);
      this.next();
      if (this.current === null && this.reported) {
        this.reported = false;
        this.onSpeaking(false);
      }
    });
  }
}
