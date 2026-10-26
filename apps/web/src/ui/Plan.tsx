// Sign in with ChatGPT in the page, as OpenAI's UI guidelines ask: "Continue with ChatGPT" to sign
// in, "Using ChatGPT plan" with a "Manage usage" link while signed in, and a one-time welcome notice.
import { useState, useSyncExternalStore } from 'react';
// OpenAI's approved button asset (developers.openai.com/siwc/website), unchanged.
import chatgptLogo from '../assets/chatgpt-logo-white.svg';
import { MANAGE_USAGE_URL } from '../lib/conversation.ts';
import type { Plan } from '../lib/plan.ts';

/** The header's plan controls; nothing unless the chosen model is a ChatGPT plan. */
export function PlanControls({ plan, onProblem }: { plan: Plan; onProblem: (text: string) => void }) {
  const status = useSyncExternalStore(plan.subscribe, plan.current);
  const [busy, setBusy] = useState(false);
  const chatgpt = status?.current === 'chatgpt' ? status.chatgpt : null;
  if (!chatgpt) return null;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch {
      onProblem("Couldn't reach Mos to change the ChatGPT sign-in. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  if (!chatgpt.signed_in) {
    return (
      <button className="btn btn-chatgpt" disabled={busy} onClick={() => void run(() => plan.signIn())}>
        <img src={chatgptLogo} alt="" width={20} height={20} />
        Continue with ChatGPT
      </button>
    );
  }
  return (
    <div className="plan" title={chatgpt.email ? `Signed in as ${chatgpt.email}` : undefined}>
      <span className="plan-chip">Using ChatGPT plan</span>
      <a className="plan-link" href={MANAGE_USAGE_URL} target="_blank" rel="noreferrer">
        Manage usage
      </a>
      <button
        className="plan-signout"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            const { revoked } = await plan.signOut();
            if (!revoked) onProblem("Signed out here, but ChatGPT didn't confirm it. You can disconnect PantryMos in ChatGPT's settings.");
          })
        }
      >
        Sign out
      </button>
    </div>
  );
}

/** Shown once per host, after the first sign-in with plan usage. */
export function PlanWelcome({ plan }: { plan: Plan }) {
  const status = useSyncExternalStore(plan.subscribe, plan.current);
  const [closing, setClosing] = useState(false);
  const chatgpt = status?.current === 'chatgpt' ? status.chatgpt : null;
  if (!chatgpt?.signed_in || chatgpt.welcomed || closing) return null;
  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="plan-welcome-title">
      <div className="dialog">
        <h2 id="plan-welcome-title">You're using your ChatGPT plan</h2>
        <p className="muted">
          When you talk to Mos, its AI requests use your ChatGPT plan. PantryMos charges nothing for it. You can see and manage this usage in{' '}
          <a href={MANAGE_USAGE_URL} target="_blank" rel="noreferrer">
            ChatGPT settings
          </a>
          .
        </p>
        <div className="card-actions">
          <button
            className="btn btn-primary"
            autoFocus
            onClick={() => {
              setClosing(true);
              void plan.welcomed().catch(() => setClosing(false));
            }}
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
