// @vitest-environment jsdom
// The cards as the page shows them (§8.2, §8.8): what each says, and what its buttons do.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Editable, ProposalCard, ProposalStatus, ProposalView } from '../../src/lib/api.ts';
import type { Conversation } from '../../src/lib/conversation.ts';
import { formatDuration, OptionsCardView, ProposalCardView, StepCardView } from '../../src/ui/Cards.tsx';

afterEach(cleanup);

const proposal = (kind: ProposalCard['kind'] = 'consume'): ProposalCard => ({
  type: 'proposal',
  proposal_id: 'p1',
  version: 1,
  kind,
  card: { title: 'Tomato egg stir-fry', lines: ['3 eggs', '2 tomatoes'], warnings: ['Short of scallion'], readback_text: 'R' },
  expires_at: '2026-10-22T01:00:00Z',
});

/** The conversation as a card uses it: each call recorded, each answer given. */
function fakeConversation(options: { problem?: string | null; editable?: Editable; loadFails?: boolean } = {}) {
  const calls: Array<[string, unknown]> = [];
  const conversation = {
    act: vi.fn(async (_card: ProposalCard, action: string) => {
      calls.push(['act', action]);
      return options.problem ?? null;
    }),
    edit: vi.fn(async (_card: ProposalCard, changes: unknown) => {
      calls.push(['edit', changes]);
      return options.problem ?? null;
    }),
    loadProposal: vi.fn(async () => {
      if (options.loadFails) throw new Error('offline');
      return { editable: options.editable ?? null } as ProposalView;
    }),
  };
  return { conversation: conversation as unknown as Conversation, calls };
}

const renderCard = (status: ProposalStatus, fake = fakeConversation(), card = proposal()) => {
  render(<ProposalCardView card={card} status={status} conversation={fake.conversation} />);
  return fake;
};

const button = (name: string) => screen.getByRole('button', { name });
/** Lets the card's async handler and its state updates finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ProposalCardView', () => {
  it('shows a pending card with its lines and warnings, and confirms or discards it', async () => {
    const { calls } = renderCard('pending');
    expect(screen.getByRole('article', { name: 'Tomato egg stir-fry' }).textContent).toContain('Record a meal');
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['3 eggs', '2 tomatoes', 'Short of scallion']);
    fireEvent.click(button('Confirm'));
    await settle();
    fireEvent.click(button('Discard'));
    await settle();
    expect(calls).toEqual([
      ['act', 'confirm'],
      ['act', 'reject'],
    ]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it("says what went wrong when the agent refuses, and an undo card can't be edited", async () => {
    renderCard('pending', fakeConversation({ problem: 'That card was replaced.' }), proposal('undo'));
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    fireEvent.click(button('Confirm'));
    await settle();
    expect(screen.getByRole('alert').textContent).toBe('That card was replaced.');
  });

  it('shows a settled card with its status and no buttons; a stale one can be refreshed', async () => {
    renderCard('committed');
    expect(screen.getByText('Saved')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toEqual([]);
    cleanup();

    const { calls } = renderCard('stale');
    expect(screen.getByText('Out of date: refresh it')).toBeTruthy();
    fireEvent.click(button('Refresh'));
    await settle();
    expect(calls).toEqual([['act', 'regenerate']]);
  });

  it('edits the amounts on the card and sends only what changed', async () => {
    const editable: Editable = { type: 'lines', field: 'usage', lines: [{ item: 'egg', quantity: 3, unit: 'count' }, { item: 'tomato', quantity: 2, unit: 'count' }] };
    const { calls } = renderCard('pending', fakeConversation({ editable }));
    fireEvent.click(button('Edit'));
    await settle();
    const [eggs] = screen.getAllByRole('spinbutton') as HTMLInputElement[];
    expect(eggs!.value).toBe('3');

    // Nothing changed: the form closes and nothing is sent.
    fireEvent.click(button('Save changes'));
    await settle();
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(calls).toEqual([]);

    fireEvent.click(button('Edit'));
    await settle();
    fireEvent.change(screen.getAllByRole('spinbutton')[0]!, { target: { value: '' } });
    fireEvent.click(button('Save changes'));
    expect(screen.getByRole('alert').textContent).toBe('Enter a number for every line.');

    fireEvent.change(screen.getAllByRole('spinbutton')[0]!, { target: { value: '4' } });
    fireEvent.click(button('Save changes'));
    await settle();
    expect(calls).toEqual([['edit', { usage: [{ item: 'egg', quantity: 4 }] }]]);
    expect(screen.queryByRole('spinbutton')).toBeNull();
  });

  it('labels a single amount and lets an edit be cancelled', async () => {
    const editable: Editable = { type: 'amount', field: 'delta', item: 'milk', value: -125, unit: 'ml' };
    renderCard('pending', fakeConversation({ editable }), proposal('adjust'));
    fireEvent.click(button('Edit'));
    await settle();
    expect(screen.getByText('(change)')).toBeTruthy();
    fireEvent.click(button('Cancel'));
    expect(screen.queryByRole('spinbutton')).toBeNull();
  });

  it('says why a card cannot be edited', async () => {
    renderCard('pending');
    fireEvent.click(button('Edit'));
    await settle();
    expect(screen.getByRole('alert').textContent).toBe('This card has nothing to edit. Refresh it instead.');
    cleanup();

    renderCard('pending', fakeConversation({ loadFails: true }));
    fireEvent.click(button('Edit'));
    await settle();
    expect(screen.getByRole('alert').textContent).toBe('Could not load the card.');
  });
});

describe('StepCardView', () => {
  it('shows the step, its place in the recipe and its timer', () => {
    render(
      <StepCardView
        card={{ type: 'step', session_id: 's', step_no: 2, total_steps: 4, step_text: 'Scramble the eggs.', timer_seconds: 60, timer_label: 'eggs' }}
      />,
    );
    const card = screen.getByRole('article', { name: 'Step 2' });
    expect(card.textContent).toContain('Step 2 of 4');
    expect(card.textContent).toContain('Scramble the eggs.');
    expect(card.textContent).toContain('eggs: 1:00');
    expect(card.textContent).not.toContain('Last step');
  });

  it('marks the last step', () => {
    render(<StepCardView card={{ type: 'step', session_id: 's', step_no: 4, done: true }} />);
    expect(screen.getByRole('article', { name: 'Step 4' }).textContent).toBe('Step 4Last step');
  });
});

describe('OptionsCardView', () => {
  it('offers each option as a button that answers with its label', () => {
    const onPick = vi.fn();
    render(
      <OptionsCardView
        card={{ type: 'options', code: 'needs_choice', ask: 'Which one?', options: ['cherry tomato', { date_label: 'new batch' }, 42] }}
        onPick={onPick}
        disabled={false}
      />,
    );
    expect(screen.getByText('Which one?')).toBeTruthy();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['cherry tomato', 'a new batch']);
    fireEvent.click(button('a new batch'));
    expect(onPick).toHaveBeenCalledWith('a new batch');
  });

  it('shows nothing when no option can be said', () => {
    const { container } = render(<OptionsCardView card={{ type: 'options', code: 'x', ask: null, options: [1] }} onPick={() => {}} disabled />);
    expect(container.innerHTML).toBe('');
  });
});

describe('formatDuration', () => {
  it('writes minutes and seconds as a clock, and short times in seconds', () => {
    expect([600, 65, 59, 0].map(formatDuration)).toEqual(['10:00', '1:05', '59s', '0s']);
  });
});
