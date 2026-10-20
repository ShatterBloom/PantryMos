// Cards (IMPLEMENTATION_PLAN §8.2, §8.8): a proposal to confirm, a recipe step, or options to pick from.
import { useState } from 'react';
import type { Editable, OptionsCard, ProposalCard, ProposalStatus, StepCard } from '../lib/api.ts';
import { editableAmounts, editChanges, optionLabel } from '../lib/cards.ts';
import type { Conversation } from '../lib/conversation.ts';

const STATUS_TEXT: Record<Exclude<ProposalStatus, 'pending'>, string> = {
  committed: 'Saved',
  rejected: 'Discarded',
  superseded: 'Replaced by a newer card',
  stale: 'Out of date: refresh it',
  expired: 'Expired',
};

export function ProposalCardView(props: { card: ProposalCard; status: ProposalStatus; conversation: Conversation }) {
  const { card, status, conversation } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ editable: NonNullable<Editable>; amounts: number[] } | null>(null);
  const pending = status === 'pending';

  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    let problem: string | null = 'Something went wrong. Please try again.';
    try {
      problem = await fn();
    } finally {
      setBusy(false);
      setError(problem);
    }
    return problem;
  };

  const startEdit = () =>
    run(async () => {
      try {
        const view = await conversation.loadProposal(card.proposal_id);
        if (!view.editable) return 'This card has nothing to edit. Refresh it instead.';
        setEditing({ editable: view.editable, amounts: editableAmounts(view.editable) });
        return null;
      } catch {
        return 'Could not load the card.';
      }
    });

  const saveEdit = async () => {
    if (!editing) return;
    if (editing.amounts.some((a) => !Number.isFinite(a))) {
      setError('Enter a number for every line.');
      return;
    }
    const changes = editChanges(editing.editable, editing.amounts);
    if (!changes) {
      setEditing(null);
      return;
    }
    if ((await run(() => conversation.edit(card, changes))) === null) setEditing(null);
  };

  return (
    <article className={`card card-proposal card-${status}`} aria-label={card.card.title}>
      <header className="card-head">
        <span className="card-kind">{KIND_LABEL[card.kind]}</span>
        <h3>{card.card.title}</h3>
        {!pending && <span className={`badge badge-${status}`}>{STATUS_TEXT[status]}</span>}
      </header>
      {editing ? (
        <EditForm editing={editing} onChange={(amounts) => setEditing({ ...editing, amounts })} />
      ) : (
        <ul className="card-lines">
          {card.card.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {card.card.warnings.length > 0 && (
        <ul className="card-warnings">
          {card.card.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {(pending || status === 'stale' || status === 'expired') && (
        <div className="card-actions">
          {editing ? (
            <>
              <button className="btn btn-primary" disabled={busy} onClick={() => void saveEdit()}>
                Save changes
              </button>
              <button className="btn" disabled={busy} onClick={() => setEditing(null)}>
                Cancel
              </button>
            </>
          ) : pending ? (
            <>
              <button className="btn btn-primary" disabled={busy} onClick={() => void run(() => conversation.act(card, 'confirm'))}>
                Confirm
              </button>
              {card.kind !== 'undo' && (
                <button className="btn" disabled={busy} onClick={() => void startEdit()}>
                  Edit
                </button>
              )}
              <button className="btn btn-quiet" disabled={busy} onClick={() => void run(() => conversation.act(card, 'reject'))}>
                Discard
              </button>
            </>
          ) : (
            <button className="btn btn-primary" disabled={busy} onClick={() => void run(() => conversation.act(card, 'regenerate'))}>
              Refresh
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="card-error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}

const KIND_LABEL: Record<ProposalCard['kind'], string> = {
  intake: 'Add to stock',
  consume: 'Record a meal',
  revise_consumption: 'Correct a meal',
  adjust: 'Adjust stock',
  undo: 'Undo',
};

function EditForm(props: { editing: { editable: NonNullable<Editable>; amounts: number[] }; onChange: (amounts: number[]) => void }) {
  const { editable, amounts } = props.editing;
  const rows =
    editable.type === 'amount'
      ? [{ item: editable.item, unit: editable.unit, label: editable.field === 'delta' ? 'change' : 'counted' }]
      : editable.lines.map((l) => ({ item: l.item, unit: l.unit, label: '' }));
  return (
    <div className="edit-form">
      {rows.map((row, i) => (
        <label key={`${row.item}-${i}`} className="edit-row">
          <span className="edit-item">
            {row.item}
            {row.label && <small> ({row.label})</small>}
          </span>
          <input
            type="number"
            inputMode="decimal"
            step="any"
            min={editable.type === 'amount' && editable.field === 'delta' ? undefined : 0}
            value={Number.isNaN(amounts[i]) ? '' : amounts[i]}
            onChange={(e) => props.onChange(amounts.map((a, j) => (j === i ? e.target.valueAsNumber : a)))}
          />
          <span className="edit-unit">{row.unit}</span>
        </label>
      ))}
    </div>
  );
}

export function StepCardView({ card }: { card: StepCard }) {
  return (
    <article className="card card-step" aria-label={`Step ${card.step_no}`}>
      <header className="card-head">
        <span className="card-kind">
          Step {card.step_no}
          {card.total_steps ? ` of ${card.total_steps}` : ''}
        </span>
        {card.done && <span className="badge badge-committed">Last step</span>}
      </header>
      {card.step_text && <p className="step-text">{card.step_text}</p>}
      {typeof card.timer_seconds === 'number' && (
        <p className="step-timer">⏱ {card.timer_label ?? 'Timer'}: {formatDuration(card.timer_seconds)}</p>
      )}
    </article>
  );
}

export function OptionsCardView(props: { card: OptionsCard; onPick: (answer: string) => void; disabled: boolean }) {
  const labels = props.card.options.map(optionLabel).filter((l): l is string => l !== null);
  if (labels.length === 0) return null;
  return (
    <article className="card card-options">
      {props.card.ask && <p className="options-ask">{props.card.ask}</p>}
      <div className="options">
        {labels.map((label) => (
          <button key={label} className="chip" disabled={props.disabled} onClick={() => props.onPick(label)}>
            {label}
          </button>
        ))}
      </div>
    </article>
  );
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}
