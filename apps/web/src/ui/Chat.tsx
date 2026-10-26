// The conversation: what the user said, what Mos said and showed, and the ways to answer (§8.7 Fallbacks).
import { type FormEvent, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Conversation, ConversationState, Entry } from '../lib/conversation.ts';
import { OptionsCardView, ProposalCardView, StepCardView } from './Cards.tsx';
import { Robot } from './Robot.tsx';

export function Chat(props: { conversation: Conversation; pushToTalk: { start(): void; stop(): void } | null }) {
  const { conversation, pushToTalk } = props;
  const state = useSyncExternalStore(conversation.subscribe, conversation.getState);
  const [draft, setDraft] = useState('');
  const [pushing, setPushing] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  // An earlier version of a card was replaced by the one read back after it.
  const latestVersion = new Map<string, number>();
  for (const e of state.entries) {
    if (e.kind !== 'mos') continue;
    for (const c of e.message.cards) if (c.type === 'proposal') latestVersion.set(c.proposal_id, Math.max(c.version, latestVersion.get(c.proposal_id) ?? 0));
  }

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [state.entries.length, state.thinking]);

  // §8.7: hold the space bar to talk, unless typing somewhere.
  useEffect(() => {
    if (!pushToTalk) return;
    const typing = (e: KeyboardEvent) => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLButtonElement;
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || typing(e)) return;
      e.preventDefault();
      setPushing(true);
      pushToTalk.start();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || typing(e)) return;
      setPushing(false);
      pushToTalk.stop();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [pushToTalk]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    void conversation.send(text, 'text');
  };

  return (
    <section className="chat" aria-label="Conversation with Mos">
      <div className="timeline" role="log" aria-live="polite">
        {state.entries.length === 0 && (
          <div className="empty">
            <span className="empty-robot">
              <Robot size={72} />
            </span>
            <p className="empty-title">Hi, I'm Mos.</p>
            <p>Tell me what you bought, ask what to cook, or say "Mos, what's expiring soon?"</p>
          </div>
        )}
        {state.entries.map((entry) => (
          <EntryView
            key={entry.key}
            entry={entry}
            conversation={conversation}
            proposals={state.proposals}
            latestVersion={latestVersion}
            busy={state.thinking}
          />
        ))}
        {state.thinking && (
          <div className="mos-row">
            <span className="mos-face">
              <Robot size={22} state="thinking" />
            </span>
            <div className="bubble bubble-mos bubble-thinking" aria-label="Mos is thinking">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
        <div ref={end} />
      </div>

      <form className="composer" onSubmit={submit}>
        {pushToTalk && (
          <button
            type="button"
            className={`btn-talk${pushing ? ' is-pushing' : ''}`}
            aria-label="Hold to talk"
            title="Hold to talk (or hold the space bar)"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              setPushing(true);
              pushToTalk.start();
            }}
            onPointerUp={() => {
              setPushing(false);
              pushToTalk.stop();
            }}
            onPointerCancel={() => {
              setPushing(false);
              pushToTalk.stop();
            }}
          >
            <MicIcon />
          </button>
        )}
        <input
          className="composer-input"
          value={draft}
          maxLength={500}
          placeholder={pushToTalk ? 'Type to Mos, or hold the mic to talk' : 'Type to Mos'}
          aria-label="Message to Mos"
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={draft.trim() === ''}>
          Send
        </button>
      </form>
    </section>
  );
}

function EntryView(props: {
  entry: Entry;
  conversation: Conversation;
  proposals: ConversationState['proposals'];
  latestVersion: ReadonlyMap<string, number>;
  busy: boolean;
}) {
  const { entry, conversation, proposals } = props;
  if (entry.kind === 'user') {
    return (
      <div className="bubble bubble-user">
        {entry.mode === 'voice' && <MicIcon small />}
        {entry.text}
      </div>
    );
  }
  if (entry.kind === 'notice') {
    return (
      <p className="notice">
        {entry.text}
        {entry.link && (
          <>
            {' '}
            <a href={entry.link.href} target="_blank" rel="noreferrer">
              {entry.link.label}
            </a>
          </>
        )}
      </p>
    );
  }
  const { message } = entry;
  return (
    <div className="mos-row">
      <span className="mos-face">
        <Robot size={22} />
      </span>
      <div className="mos">
      {message.speech && (
        <div className={`bubble bubble-mos${message.turn_type === 'proactive' ? ' bubble-proactive' : ''}`}>{message.speech}</div>
      )}
      {message.cards.map((card, i) => {
        if (card.type === 'proposal') {
          return (
            <ProposalCardView
              key={`${card.proposal_id}-${card.version}`}
              card={card}
              status={card.version < (props.latestVersion.get(card.proposal_id) ?? 0) ? 'superseded' : (proposals[card.proposal_id] ?? 'pending')}
              conversation={conversation}
            />
          );
        }
        if (card.type === 'step') return <StepCardView key={`step-${card.step_no}-${i}`} card={card} />;
        return (
          <OptionsCardView key={`options-${i}`} card={card} disabled={props.busy} onPick={(answer) => void conversation.send(answer, 'text')} />
        );
      })}
      </div>
    </div>
  );
}

export function MicIcon({ small }: { small?: boolean }) {
  const size = small ? 14 : 22;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="icon">
      <path
        fill="currentColor"
        d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z"
      />
    </svg>
  );
}
