import { useRef, useState } from 'react';

// Minimal Web Speech typings (not in lib.dom for all browsers).
interface RecognitionResultEvent {
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}
interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: RecognitionResultEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | undefined {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

/** Spike V4: speech recognition + synthesis round trip in Chrome. */
export function VoiceCheck() {
  const [transcript, setTranscript] = useState('');
  const [status, setStatus] = useState('idle');
  const recognition = useRef<Recognition | null>(null);
  const Ctor = recognitionCtor();

  const listen = () => {
    if (!Ctor) return;
    const r = new Ctor();
    r.continuous = false;
    r.interimResults = false;
    r.lang = 'en-US';
    r.onresult = (e) => {
      const text = Array.from(e.results)
        .map((res) => res[0]?.transcript ?? '')
        .join(' ')
        .trim();
      setTranscript(text);
      speechSynthesis.speak(new SpeechSynthesisUtterance(`You said: ${text}`));
    };
    r.onerror = (e) => setStatus(`error: ${e.error}`);
    r.onend = () => setStatus('idle');
    recognition.current = r;
    setStatus('listening');
    r.start();
  };

  return (
    <section>
      <h2>Voice check</h2>
      {!Ctor ? (
        <p>Speech recognition is not available in this browser. Use Chrome.</p>
      ) : (
        <>
          <button type="button" onClick={listen} disabled={status === 'listening'}>
            {status === 'listening' ? 'Listening…' : 'Say something'}
          </button>
          <p>Status: {status}</p>
          {transcript && <p>Heard: “{transcript}”</p>}
        </>
      )}
    </section>
  );
}
