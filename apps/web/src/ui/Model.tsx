// Choosing the model Mos runs on: the chosen one in the header, and the providers to pick from, the
// ones not set up greyed with how to set them up. Asked first while none is chosen.
import { useState, useSyncExternalStore } from 'react';
import type { ModelStatus, Provider } from '../lib/api.ts';
import type { Plan } from '../lib/plan.ts';

export const PROVIDER_NAMES: Record<Provider, string> = {
  bedrock: 'Amazon Nova',
  openai: 'OpenAI-compatible API',
  chatgpt: 'ChatGPT plan',
};

/** The line under a provider's name: its model, or how to set it up. */
function detail(option: ModelStatus['models'][number], status: ModelStatus): string {
  if (!option.configured) return `Not set up: add ${option.provider} to MODEL_PROVIDERS`;
  if (option.provider === 'bedrock') return `${option.model} on Amazon Bedrock`;
  if (option.provider === 'chatgpt') {
    const model = option.model ?? status.chatgpt?.model;
    const plan = model ? `${model} on your plan` : "Your plan's default model";
    return status.chatgpt?.signed_in ? plan : `${plan}; sign in after choosing it`;
  }
  return option.model ?? '';
}

export function ModelPicker({ plan, onProblem }: { plan: Plan; onProblem: (text: string) => void }) {
  const status = useSyncExternalStore(plan.subscribe, plan.current);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!status) return null;
  const choosing = open || status.current === null;

  const choose = async (provider: Provider) => {
    if (provider === status.current) return setOpen(false);
    setBusy(true);
    try {
      await plan.choose(provider);
      setOpen(false);
    } catch {
      onProblem("Couldn't reach Mos to change the model. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button className="btn btn-quiet" onClick={() => setOpen(true)} title="Choose which model Mos uses">
        {status.current ? `Model: ${PROVIDER_NAMES[status.current]}` : 'Choose a model'}
      </button>
      {choosing && (
        <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="model-title">
          <div className="dialog">
            <h2 id="model-title">Which model should Mos use?</h2>
            <p className="muted">You can switch at any time; the conversation carries on.</p>
            <div className="model-options">
              {status.models.map((option) => (
                <button
                  key={option.provider}
                  className="model-option"
                  aria-pressed={option.provider === status.current}
                  disabled={!option.configured || busy}
                  onClick={() => void choose(option.provider)}
                >
                  <span className="model-name">{PROVIDER_NAMES[option.provider]}</span>
                  <span className="model-detail">{detail(option, status)}</span>
                </button>
              ))}
            </div>
            {status.current !== null && (
              <div className="card-actions">
                <button className="btn btn-quiet" onClick={() => setOpen(false)}>
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
