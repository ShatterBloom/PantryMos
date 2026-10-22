// @vitest-environment jsdom
// The kitchen as recorded (§8.8): stock, the shopping list, the ledger and the timers strip.
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Api, Inventory, LedgerOperation, Timer } from '../../src/lib/api.ts';
import { KitchenPanel, LedgerPanel, TimersStrip } from '../../src/ui/Panels.tsx';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const asApi = (api: Partial<Record<keyof Api, unknown>>) => api as unknown as Api;
/** Lets the first poll answer. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

const inventory: Inventory = {
  today: '2026-10-22',
  items: [
    {
      item: 'egg',
      total: 9,
      unit: 'count',
      batches: [
        { batch_id: 'b1', quantity: 6, date_label: 'best before Oct 30', priority_source: 'package' },
        { batch_id: 'b2', quantity: 3, date_label: 'bought today, no package date', priority_source: 'estimate' },
      ],
    },
    { item: 'milk', total: 125.004, unit: 'ml', batches: [] },
  ],
  shopping_list: [
    { id: 's1', item: 'scallion', quantity: 2, unit: 'count', source: 'shortfall' },
    { id: 's2', item: 'bread', quantity: null, unit: null, source: 'manual' },
  ],
};

describe('KitchenPanel', () => {
  it('shows each item, its batches as the server labels them, and the shopping list', async () => {
    render(<KitchenPanel api={asApi({ inventory: async () => inventory })} />);
    expect(screen.getByText('Loading…')).toBeTruthy();
    await settle();
    const [eggs, milk] = screen.getAllByRole('listitem').filter((li) => li.classList.contains('stock-item'));
    expect(eggs!.textContent).toBe('egg9 6 best before Oct 303 bought today, no package date');
    expect(milk!.textContent).toBe('milk125 ml');
    expect(screen.getByText('scallion').textContent).toBe('scallion · 2 countfor a recipe');
    expect(screen.getByText('bread').textContent).toBe('bread');
    expect(screen.getByText('Today: 2026-10-22')).toBeTruthy();
  });

  it('says when nothing is recorded, and when Mos cannot be reached', async () => {
    render(<KitchenPanel api={asApi({ inventory: async () => ({ today: '2026-10-22', items: [], shopping_list: [] }) })} />);
    await settle();
    expect(screen.getByText('Nothing recorded yet. Tell Mos what you bought.')).toBeTruthy();
    expect(screen.getByText('Empty.')).toBeTruthy();
    cleanup();

    render(<KitchenPanel api={asApi({ inventory: async () => Promise.reject(new Error('offline')) })} />);
    await settle();
    expect(screen.getByText('Cannot reach Mos right now.')).toBeTruthy();
  });
});

describe('LedgerPanel', () => {
  const op = (extra: Partial<LedgerOperation>): LedgerOperation => ({
    operation_id: 'o1',
    kind: 'consume',
    summary: 'Used 3 eggs',
    changes: [],
    proposal_version: 1,
    confirmed: { channel: 'ui_click', utterance: null, user_id: 'u' },
    reverted_by: null,
    reverts_operation_ids: [],
    created_at: '2026-10-22T08:00:00Z',
    ...extra,
  });

  it('shows each change, how it was confirmed, its card version and whether it was undone', async () => {
    const operations = [
      op({ operation_id: 'o2', summary: 'Added 12 eggs', confirmed: { channel: 'voice_rule', utterance: 'yes', user_id: 'u' }, proposal_version: 2 }),
      op({ reverted_by: 'o3' }),
    ];
    render(<LedgerPanel api={asApi({ ledger: async () => ({ used_first: { days: 7, batches: [] }, operations }) })} />);
    await settle();
    expect(screen.getByText('Nothing that was due soon was used in the last 7 days.')).toBeTruthy();
    const [voice, undone] = screen.getAllByRole('listitem');
    expect(voice!.textContent).toContain('said "yes"');
    expect(voice!.textContent).toContain('card v2');
    expect(voice!.classList.contains('is-reverted')).toBe(false);
    expect(undone!.textContent).toContain('tapped Confirm');
    expect(undone!.textContent).toContain('undone');
    expect(undone!.classList.contains('is-reverted')).toBe(true);
  });

  it('sums up what was used first this week, each batch linking to its ledger entries (story G2)', async () => {
    const operations = [op({ operation_id: 'o2', kind: 'revise_consumption' }), op({ operation_id: 'o1' })];
    const used_first = {
      days: 7,
      batches: [
        { batch_id: 'b1', item: 'tomato', quantity: 3, unit: 'count', date_label: 'stored for 5 days, no package date', operation_ids: ['o1', 'o2'] },
        { batch_id: 'b2', item: 'milk', quantity: 250, unit: 'ml', date_label: 'best by Oct 24 (from package)', operation_ids: ['gone'] },
      ],
    };
    render(<LedgerPanel api={asApi({ ledger: async () => ({ used_first, operations }) })} />);
    await settle();
    const summary = screen.getByRole('region', { name: 'Used first this week' });
    expect(summary.textContent).toContain('2 batches used before they went bad');
    const [tomato, milk] = Array.from(summary.querySelectorAll('li'));
    expect(tomato!.textContent).toContain('tomato 3');
    expect(tomato!.textContent).toContain('stored for 5 days, no package date');
    expect(Array.from(tomato!.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual(['#op-o1', '#op-o2']);
    // An entry older than the ledger shows has no link.
    expect(milk!.textContent).toContain('milk 250 ml');
    expect(milk!.querySelectorAll('a')).toHaveLength(0);
    expect(document.getElementById('op-o2')).toBeTruthy();
  });

  it('says when nothing has changed yet', async () => {
    render(<LedgerPanel api={asApi({ ledger: async () => ({ used_first: { days: 7, batches: [] }, operations: [] }) })} />);
    await settle();
    expect(screen.getByText('No changes recorded yet.')).toBeTruthy();
  });
});

describe('TimersStrip', () => {
  const timer = (extra: Partial<Timer>): Timer => ({ id: 't1', label: 'pasta', seconds: 480, status: 'running', remaining_seconds: 125, ...extra });

  it('counts a running timer down between polls, and holds a paused one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] });
    const timers = [timer({}), timer({ id: 't2', label: 'rice', status: 'paused', remaining_seconds: 30 })];
    // The first poll answers; later ones never do, so the countdown runs from it.
    const api = asApi({ timers: vi.fn().mockResolvedValueOnce({ timers }).mockReturnValue(new Promise(() => {})) });
    render(<TimersStrip api={api} conversationId="c1" />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    const strip = screen.getByLabelText('Timers');
    expect(strip.textContent).toBe('pasta2:05rice30spaused');
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(strip.textContent).toBe('pasta2:02rice30spaused');
  });

  it('shows nothing for a conversation the agent does not know yet', async () => {
    const { container } = render(<TimersStrip api={asApi({ timers: async () => Promise.reject(new Error('404')) })} conversationId="c1" />);
    await settle();
    expect(container.innerHTML).toBe('');
  });
});
