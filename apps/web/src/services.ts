// The page's long-lived objects, wired once: API client, speech out, conversation, and listening.
import { chime, createRecognizer, createSynth, localMemory, speechSynthesisAvailable } from './browser.ts';
import { address } from './lib/addressing.ts';
import { Api } from './lib/api.ts';
import { Conversation } from './lib/conversation.ts';
import { HandsFreeController, type HandsFreeState } from './lib/handsFree.ts';
import { Speaker, type Synth } from './lib/speaker.ts';

export interface Services {
  api: Api;
  speaker: Speaker;
  conversation: Conversation;
  /** Null where the browser has no speech recognition (§8.7: Chrome). */
  handsFree: HandsFreeController | null;
  pushToTalk: { start(): void; stop(): void } | null;
  handsFreeState(): HandsFreeState;
  onHandsFreeChange(listener: () => void): () => void;
}

const silentSynth: Synth = {
  speak: (_text, done) => setTimeout(done, 0),
  cancel: () => {},
};

export function createServices(askPasscode: () => Promise<string | null>): Services {
  const clock = { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (h: unknown) => clearTimeout(h as number) };
  const api = new Api({ fetch: (input, init) => fetch(input, init), passcode: askPasscode, newId: () => crypto.randomUUID() });

  let handsFree: HandsFreeController | null = null;
  // The speaker reports to the conversation, which speaks through the speaker.
  let conversation: Conversation | null = null;
  const speaker = new Speaker({
    synth: speechSynthesisAvailable() ? createSynth() : silentSynth,
    onSpeaking: (speaking) => handsFree?.setSpeaking(speaking),
    onSpoken: (message) => void conversation?.spoken(message),
  });
  const convo = new Conversation({
    api,
    speaker,
    memory: localMemory,
    newId: () => crypto.randomUUID(),
    now: () => Date.now(),
    hooks: { onStep: () => handsFree?.sessionStarted(), onMealRecorded: () => handsFree?.sessionEnded() },
  });
  conversation = convo;

  /** One recognized utterance, from hands-free listening or push-to-talk. */
  const heard = (transcript: string, pushed: boolean) => {
    const addressed = address(transcript, convo.openWindow());
    if (addressed.kind === 'command') {
      if (addressed.command === 'hands_free_on') handsFree?.enable();
      else handsFree?.disable();
      chime();
      return;
    }
    // Holding the button addresses Mos already; hands-free needs the wake word (or a window phrase).
    const text = addressed.kind === 'send' ? addressed.text : pushed ? transcript : null;
    if (text === null) return;
    chime();
    void convo.send(text, 'voice');
  };

  const listeners = new Set<() => void>();
  let state: HandsFreeState = { enabled: false, listening: false, error: null };
  const continuous = createRecognizer(true);
  if (continuous) {
    handsFree = new HandsFreeController({
      recognizer: continuous,
      clock,
      onUtterance: (t) => heard(t, false),
      onChange: (next) => {
        if (next.error && next.error !== state.error) convo.notice(microphoneProblem(next.error));
        state = next;
        for (const l of listeners) l();
      },
    });
  }

  const oneShot = createRecognizer(false);
  let pushing = false;
  if (oneShot) oneShot.onResult = (t) => heard(t, true);
  const pushToTalk = oneShot
    ? {
        start() {
          if (pushing) return;
          pushing = true;
          speaker.stop(); // the user is talking: stop reading out
          handsFree?.setSpeaking(true); // and keep the continuous listener off the same microphone
          try {
            oneShot.start();
          } catch {
            // Still stopping from the last press.
          }
        },
        stop() {
          if (!pushing) return;
          pushing = false;
          oneShot.stop();
          handsFree?.setSpeaking(false);
        },
      }
    : null;

  return {
    api,
    speaker,
    conversation: convo,
    handsFree,
    pushToTalk,
    handsFreeState: () => state,
    onHandsFreeChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function microphoneProblem(error: string): string {
  return error === 'not-allowed' || error === 'service-not-allowed'
    ? 'Microphone access was refused, so hands-free is off. Allow the microphone and turn it on again.'
    : 'No microphone was found, so hands-free is off.';
}
