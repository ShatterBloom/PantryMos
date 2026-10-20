// The kitchen as recorded (§8.8): stock and the shopping list, the ledger, and running timers.
import type { Api, Inventory, LedgerOperation, Timer } from '../lib/api.ts';
import { formatDuration } from './Cards.tsx';
import { useNow, usePolling } from './hooks.ts';

const POLL_MS = 2000;

export function KitchenPanel({ api }: { api: Api }) {
  const { data, error } = usePolling<Inventory>(() => api.inventory(), POLL_MS);
  if (!data) return <PanelStatus error={error} />;
  return (
    <div className="panel-body">
      {data.items.length === 0 ? (
        <p className="muted">Nothing recorded yet. Tell Mos what you bought.</p>
      ) : (
        <ul className="stock">
          {data.items.map((item) => (
            <li key={item.item} className="stock-item">
              <div className="stock-head">
                <span className="stock-name">{item.item}</span>
                <span className="stock-total">
                  {formatAmount(item.total)} {unitLabel(item.unit)}
                </span>
              </div>
              <ul className="batches">
                {item.batches.map((b) => (
                  <li key={b.batch_id} className="batch">
                    <span>
                      {formatAmount(b.quantity)} {unitLabel(item.unit)}
                    </span>
                    {/* The server's own words (PRD FR-7): shown as given, never reinterpreted. */}
                    <span className="batch-date">{b.date_label}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      <h3 className="panel-sub">Shopping list</h3>
      {data.shopping_list.length === 0 ? (
        <p className="muted">Empty.</p>
      ) : (
        <ul className="shopping">
          {data.shopping_list.map((s) => (
            <li key={s.id}>
              {s.item}
              {s.quantity !== null && (
                <span className="muted">
                  {' '}
                  · {formatAmount(s.quantity)} {s.unit}
                </span>
              )}
              {s.source === 'shortfall' && <span className="tag">for a recipe</span>}
            </li>
          ))}
        </ul>
      )}
      <p className="panel-foot muted">Today: {data.today}</p>
    </div>
  );
}

export function LedgerPanel({ api }: { api: Api }) {
  const { data, error } = usePolling<{ operations: LedgerOperation[] }>(() => api.ledger(50), POLL_MS);
  if (!data) return <PanelStatus error={error} />;
  if (data.operations.length === 0) return <p className="muted panel-body">No changes recorded yet.</p>;
  return (
    <ol className="ledger panel-body">
      {data.operations.map((op) => (
        <li key={op.operation_id} className={`ledger-op${op.reverted_by ? ' is-reverted' : ''}`}>
          <div className="ledger-head">
            <span className="ledger-summary">{op.summary}</span>
            <time dateTime={op.created_at}>{formatTime(op.created_at)}</time>
          </div>
          <div className="ledger-meta">
            {op.confirmed.channel === 'voice_rule' ? (
              <span className="tag">said "{op.confirmed.utterance}"</span>
            ) : (
              <span className="tag">tapped Confirm</span>
            )}
            {op.proposal_version > 1 && <span className="tag">card v{op.proposal_version}</span>}
            {op.reverted_by && <span className="tag tag-warn">undone</span>}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function TimersStrip({ api, conversationId }: { api: Api; conversationId: string }) {
  const { data, at } = usePolling<{ timers: Timer[] } | null>(async () => {
    try {
      return await api.timers(conversationId);
    } catch {
      return null; // a new conversation is unknown until its first message
    }
  }, POLL_MS);
  const now = useNow(1000);
  const timers = data?.timers ?? [];
  if (timers.length === 0) return null;
  return (
    <div className="timers" aria-label="Timers">
      {timers.map((t) => {
        // A running timer counts down between polls, from when the last poll answered.
        const left =
          t.remaining_seconds === null
            ? null
            : t.status === 'running'
              ? Math.max(0, t.remaining_seconds - Math.floor((now - at) / 1000))
              : t.remaining_seconds;
        return (
          <div key={t.id} className={`timer timer-${t.status}`}>
            <span className="timer-label">{t.label}</span>
            <span className="timer-left">{left === null ? '–' : formatDuration(left)}</span>
            {t.status === 'paused' && <span className="tag">paused</span>}
          </div>
        );
      })}
    </div>
  );
}

function PanelStatus({ error }: { error: boolean }) {
  return <p className="muted panel-body">{error ? 'Cannot reach Mos right now.' : 'Loading…'}</p>;
}

const UNIT_LABEL: Record<string, string> = { count: '', g: 'g', ml: 'ml' };
const unitLabel = (unit: string) => UNIT_LABEL[unit] ?? unit;
const formatAmount = (n: number) => String(Math.round(n * 100) / 100);
const formatTime = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
