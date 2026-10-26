// PantryMos web app (IMPLEMENTATION_PLAN §8.7, §8.8): talk to Mos, answer cards, see the kitchen.
import { type FormEvent, useEffect, useState, useSyncExternalStore } from 'react';
import { forgetConversation, speechRecognitionAvailable } from './browser.ts';
import { createServices, type Services } from './services.ts';
import { Chat, MicIcon } from './ui/Chat.tsx';
import { signInResult } from './lib/plan.ts';
import { Inbox } from './ui/Inbox.tsx';
import { KitchenPanel, LedgerPanel, TimersStrip } from './ui/Panels.tsx';
import { PlanControls, PlanWelcome } from './ui/Plan.tsx';

/** The passcode prompt, asked by the API client when a deployed agent needs one (§11.4). */
let askForPasscode: ((resolve: (passcode: string | null) => void) => void) | null = null;
const services: Services = createServices(
  () =>
    new Promise((resolve) => {
      if (askForPasscode) askForPasscode(resolve);
      else resolve(null);
    }),
);

type Tab = 'kitchen' | 'ledger';

export function App() {
  const { conversation, api, handsFree, speaker, plan } = services;
  const [tab, setTab] = useState<Tab>('kitchen');
  const [muted, setMuted] = useState(false);
  const [passcodeRequest, setPasscodeRequest] = useState<((passcode: string | null) => void) | null>(null);
  const listening = useSyncExternalStore(services.onHandsFreeChange, services.handsFreeState);

  useEffect(() => {
    askForPasscode = (resolve) => setPasscodeRequest(() => resolve);
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    // §1.2: poll for new messages (user and proactive) and card states every 2 s.
    const tick = async () => {
      try {
        await conversation.poll();
        await conversation.refreshProposals();
        await conversation.refreshInbox();
      } catch {
        // Shown by the panels' own polling; the next tick tries again.
      }
      if (alive) timer = setTimeout(tick, 2000);
    };
    // Back from Sign in with ChatGPT: say how it went once, and drop it from the address.
    const result = signInResult(window.location.search);
    if (new URLSearchParams(window.location.search).has('chatgpt')) window.history.replaceState(null, '', window.location.pathname);
    if (result) conversation.notice(result);
    void api
      .ensureSession()
      .catch(() => {})
      .finally(() => {
        void plan.refresh().catch(() => {});
        void tick();
      });
    const leave = () => speaker.stop();
    window.addEventListener('pagehide', leave);
    return () => {
      alive = false;
      clearTimeout(timer);
      askForPasscode = null;
      window.removeEventListener('pagehide', leave);
    };
  }, [api, conversation, speaker, plan]);

  const toggleMute = () => {
    speaker.setMuted(!muted);
    setMuted(!muted);
  };

  const newConversation = () => {
    forgetConversation();
    window.location.reload();
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            M
          </span>
          <div>
            <h1>PantryMos</h1>
            <p className="brand-sub">Mos, your hands-free kitchen helper</p>
          </div>
        </div>
        <div className="controls">
          <PlanControls plan={plan} onProblem={(text) => conversation.notice(text)} />
          {handsFree ? (
            <button
              className={`btn-handsfree${listening.enabled ? ' is-on' : ''}`}
              aria-pressed={listening.enabled}
              onClick={() => (listening.enabled ? handsFree.disable() : handsFree.enable())}
              title={listening.enabled ? 'Say "Mos, stop listening" or tap to stop' : 'Listen for "Mos, …"'}
            >
              <span className={`pulse${listening.listening ? ' is-live' : ''}`} aria-hidden="true" />
              <MicIcon small />
              {listening.enabled ? (listening.listening ? 'Listening' : 'Paused') : 'Hands-free off'}
            </button>
          ) : (
            <span className="muted small">{speechRecognitionAvailable() ? '' : 'Voice needs Chrome'}</span>
          )}
          <button className="btn btn-quiet" aria-pressed={muted} onClick={toggleMute} title={muted ? 'Mos will speak again' : 'Mos stays silent'}>
            {muted ? 'Unmute' : 'Mute'}
          </button>
          <button className="btn btn-quiet" onClick={newConversation} title="Start a new conversation">
            New chat
          </button>
        </div>
      </header>

      <main className="layout">
        <div className="main-col">
          <TimersStrip api={api} conversationId={conversation.conversationId} />
          <Inbox conversation={conversation} />
          <Chat conversation={conversation} pushToTalk={services.pushToTalk} />
        </div>
        <aside className="side-col" aria-label="Kitchen">
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'kitchen'} className={tab === 'kitchen' ? 'tab is-active' : 'tab'} onClick={() => setTab('kitchen')}>
              Kitchen
            </button>
            <button role="tab" aria-selected={tab === 'ledger'} className={tab === 'ledger' ? 'tab is-active' : 'tab'} onClick={() => setTab('ledger')}>
              Ledger
            </button>
          </div>
          {tab === 'kitchen' ? <KitchenPanel api={api} /> : <LedgerPanel api={api} />}
        </aside>
      </main>

      <PlanWelcome plan={plan} />

      {passcodeRequest && (
        <PasscodeDialog
          onDone={(passcode) => {
            passcodeRequest(passcode);
            setPasscodeRequest(null);
          }}
        />
      )}
    </div>
  );
}

function PasscodeDialog({ onDone }: { onDone: (passcode: string | null) => void }) {
  const [value, setValue] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onDone(value);
  };
  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="passcode-title">
      <form className="dialog" onSubmit={submit}>
        <h2 id="passcode-title">Sign in</h2>
        <p className="muted">Enter the demo passcode.</p>
        <input type="password" autoFocus value={value} onChange={(e) => setValue(e.target.value)} aria-label="Passcode" />
        <div className="card-actions">
          <button type="submit" className="btn btn-primary" disabled={value === ''}>
            Sign in
          </button>
          <button type="button" className="btn btn-quiet" onClick={() => onDone(null)}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
