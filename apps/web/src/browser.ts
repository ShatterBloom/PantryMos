// The browser APIs behind lib/'s interfaces: Web Speech recognition and synthesis, localStorage, a chime.
import type { Memory } from './lib/conversation.ts';
import type { Recognizer } from './lib/handsFree.ts';
import type { Synth } from './lib/speaker.ts';

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly 0: { readonly transcript: string };
}
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((event: { resultIndex: number; results: ArrayLike<SpeechRecognitionResultLike> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
}
type RecognitionCtor = new () => SpeechRecognitionLike;

const recognitionCtor = (): RecognitionCtor | undefined =>
  (window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }).SpeechRecognition ??
  (window as unknown as { webkitSpeechRecognition?: RecognitionCtor }).webkitSpeechRecognition;

export const speechRecognitionAvailable = () => recognitionCtor() !== undefined;
export const speechSynthesisAvailable = () => 'speechSynthesis' in window;

/** Final results only; `continuous` for hands-free, one phrase for push-to-talk (§8.7). */
export function createRecognizer(continuous: boolean): Recognizer | null {
  const Ctor = recognitionCtor();
  if (!Ctor) return null;
  const recognition = new Ctor();
  recognition.continuous = continuous;
  recognition.interimResults = false;
  recognition.lang = 'en-US';
  const recognizer: Recognizer = {
    start: () => recognition.start(),
    stop: () => recognition.stop(),
    onResult: null,
    onEnd: null,
    onError: null,
  };
  recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i]!;
      const transcript = result[0].transcript.trim();
      if (result.isFinal && transcript !== '') recognizer.onResult?.(transcript);
    }
  };
  recognition.onend = () => recognizer.onEnd?.();
  recognition.onerror = (event) => recognizer.onError?.(event.error);
  return recognizer;
}

/**
 * Chrome ends a cancelled utterance with `error` ("interrupted"/"canceled") or, in some versions,
 * with `end`; the cancelled flag makes both read as interrupted, so only a full play is "completed".
 */
export function createSynth(): Synth {
  let current: { cancelled: boolean } | null = null;
  return {
    speak(text, done) {
      const state = { cancelled: false };
      current = state;
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'en-US';
      utterance.rate = 1.05;
      utterance.onend = () => done(state.cancelled ? 'interrupted' : 'completed');
      utterance.onerror = () => done('interrupted');
      window.speechSynthesis.speak(utterance);
    },
    cancel() {
      if (current) current.cancelled = true;
      window.speechSynthesis.cancel();
    },
  };
}

const MEMORY_KEY = 'pantrymos.conversation';

/** Per-browser memory of the conversation; private windows and blocked storage just start fresh. */
export const localMemory: Memory = {
  load() {
    try {
      const raw = localStorage.getItem(MEMORY_KEY);
      return raw ? (JSON.parse(raw) as ReturnType<Memory['load']>) : null;
    } catch {
      return null;
    }
  },
  save(value) {
    try {
      localStorage.setItem(MEMORY_KEY, JSON.stringify(value));
    } catch {
      // Not remembered; the conversation goes on.
    }
  },
};

export function forgetConversation(): void {
  try {
    localStorage.removeItem(MEMORY_KEY);
  } catch {
    // Nothing to forget.
  }
}

let audio: AudioContext | null = null;

/** §8.7 Feedback: a short chime when an utterance is accepted. */
export function chime(): void {
  try {
    audio ??= new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.08, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.18);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.2);
  } catch {
    // No audio: the transcript on screen is the feedback.
  }
}
