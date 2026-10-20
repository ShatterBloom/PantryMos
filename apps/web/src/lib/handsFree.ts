// Hands-free listening (IMPLEMENTATION_PLAN §8.7): continuous recognition that restarts itself, pauses
// while Mos speaks, and turns itself off a while after the cooking session ends.

/** The browser's SpeechRecognition, reduced to what the controller drives. */
export interface Recognizer {
  start(): void;
  stop(): void;
  /** Final results only. */
  onResult: ((transcript: string) => void) | null;
  /** Recognition stopped, by itself (silence, a network blip) or after stop(). */
  onEnd: (() => void) | null;
  onError: ((error: string) => void) | null;
}

export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const RESTART_MIN_MS = 500;
export const RESTART_MAX_MS = 5000;
/** Mos never hears itself: recognition resumes this long after speech ends. */
export const ECHO_GUARD_MS = 300;
/** Hands-free turns itself off this long after the cooking session ends. */
export const AUTO_OFF_MS = 2 * 60 * 1000;

/** Errors that a restart cannot fix: the user or the browser said no to the microphone. */
const FATAL = new Set(['not-allowed', 'service-not-allowed', 'audio-capture']);

export type HandsFreeState = { enabled: boolean; listening: boolean; error: string | null };

export class HandsFreeController {
  private enabled = false;
  private speaking = false;
  private running = false;
  private error: string | null = null;
  private restartMs = RESTART_MIN_MS;
  private restartTimer: unknown = null;
  private autoOffTimer: unknown = null;
  private readonly recognizer: Recognizer;
  private readonly clock: Clock;
  private readonly onUtterance: (transcript: string) => void;
  private readonly onChange: (state: HandsFreeState) => void;

  constructor(options: {
    recognizer: Recognizer;
    clock: Clock;
    onUtterance: (transcript: string) => void;
    onChange: (state: HandsFreeState) => void;
  }) {
    this.recognizer = options.recognizer;
    this.clock = options.clock;
    this.onUtterance = options.onUtterance;
    this.onChange = options.onChange;
    this.recognizer.onResult = (transcript) => {
      this.restartMs = RESTART_MIN_MS; // it works again: next restart is quick
      if (this.enabled && !this.speaking) this.onUtterance(transcript);
    };
    this.recognizer.onEnd = () => {
      this.running = false;
      this.scheduleRestart();
      this.emit();
    };
    this.recognizer.onError = (error) => {
      if (FATAL.has(error)) {
        this.error = error;
        this.disable();
      }
    };
  }

  get state(): HandsFreeState {
    return { enabled: this.enabled, listening: this.running, error: this.error };
  }

  enable(): void {
    this.cancelAutoOff();
    if (this.enabled) return;
    this.enabled = true;
    this.error = null;
    this.restartMs = RESTART_MIN_MS;
    this.listen();
    this.emit();
  }

  disable(): void {
    this.cancelAutoOff();
    this.enabled = false;
    this.clearRestart();
    if (this.running) this.recognizer.stop();
    this.emit();
  }

  /** §8.7 Echo control: no listening while Mos speaks, nor for a moment after. */
  setSpeaking(speaking: boolean): void {
    if (speaking === this.speaking) return;
    this.speaking = speaking;
    this.clearRestart();
    if (speaking) {
      if (this.running) this.recognizer.stop();
    } else if (this.enabled) {
      this.restartTimer = this.clock.setTimeout(() => this.listen(), ECHO_GUARD_MS);
    }
  }

  /** A cooking session started (a step was delivered): listen, and stay on. */
  sessionStarted(): void {
    this.enable();
  }

  /** The cooking session ended: turn off after a while, unless a new one starts. */
  sessionEnded(): void {
    if (!this.enabled) return;
    this.cancelAutoOff();
    this.autoOffTimer = this.clock.setTimeout(() => this.disable(), AUTO_OFF_MS);
  }

  private listen(): void {
    this.restartTimer = null;
    if (!this.enabled || this.speaking || this.running) return;
    this.running = true;
    try {
      this.recognizer.start();
    } catch {
      // Already starting (the browser throws InvalidStateError); its end event restarts it.
    }
    this.emit();
  }

  /** §8.7: restart after silence or an error, backing off 0.5 s → 5 s until a result comes. */
  private scheduleRestart(): void {
    if (!this.enabled || this.speaking || this.restartTimer !== null) return;
    const delay = this.restartMs;
    this.restartMs = Math.min(this.restartMs * 2, RESTART_MAX_MS);
    this.restartTimer = this.clock.setTimeout(() => this.listen(), delay);
  }

  private clearRestart(): void {
    if (this.restartTimer !== null) this.clock.clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private cancelAutoOff(): void {
    if (this.autoOffTimer !== null) this.clock.clearTimeout(this.autoOffTimer);
    this.autoOffTimer = null;
  }

  private emit(): void {
    this.onChange(this.state);
  }
}
