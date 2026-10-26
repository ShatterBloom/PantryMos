// @vitest-environment jsdom
// The conversation as the page shows it (§8.7): the timeline, the composer and push-to-talk.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Card, Message, ProposalCard } from '../../src/lib/api.ts';
import type { Conversation, ConversationState, Entry } from '../../src/lib/conversation.ts';
import { Chat } from '../../src/ui/Chat.tsx';

beforeAll(() => {
  // jsdom lays nothing out.
  Element.prototype.scrollIntoView = () => {};
});
afterEach(cleanup);

const message = (id: number, extra: Partial<Message> = {}): Message => ({
  id,
  turn_type: 'user',
  speech: '',
  cards: [],
  voice_prompt: null,
  session_id: null,
  step_no: null,
  created_at: '2026-10-22T00:00:00Z',
  ...extra,
});

const proposal = (version: number): ProposalCard => ({
  type: 'proposal',
  proposal_id: 'p1',
  version,
  kind: 'intake',
  card: { title: `Add eggs v${version}`, lines: [], warnings: [], readback_text: 'R' },
  expires_at: '2026-10-22T01:00:00Z',
});

const mos = (id: number, speech: string, cards: Card[] = [], extra: Partial<Message> = {}): Entry => ({
  kind: 'mos',
  key: `m${id}`,
  message: message(id, { speech, cards, ...extra }),
});

/** The conversation as the chat uses it: a state to show, changed by `set`, and what was sent. */
function fakeConversation(initial: Partial<ConversationState> = {}) {
  let state: ConversationState = { entries: [], thinking: false, window: null, proposals: {}, inbox: [], ...initial };
  const listeners = new Set<() => void>();
  const sent: Array<[string, string]> = [];
  const conversation = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    send: async (text: string, mode: string) => {
      sent.push([text, mode]);
    },
  };
  const set = (next: Partial<ConversationState>) =>
    act(() => {
      state = { ...state, ...next };
      for (const l of listeners) l();
    });
  return { conversation: conversation as unknown as Conversation, sent, set };
}

describe('Chat', () => {
  it('greets an empty conversation, then shows what each side said', () => {
    const fake = fakeConversation();
    render(<Chat conversation={fake.conversation} pushToTalk={null} />);
    expect(screen.getByText("Hi, I'm Mos.")).toBeTruthy();

    fake.set({
      entries: [
        { kind: 'user', key: 'u1', text: 'what is expiring?', mode: 'voice' },
        mos(1, 'Your spinach expires today.'),
        { kind: 'notice', key: 'n1', text: 'Mos is offline.' },
        { kind: 'notice', key: 'n2', text: 'Out of plan usage.', link: { href: 'https://chatgpt.com/settings/usage', label: 'Manage usage' } },
        mos(2, 'Time is up for the pasta.', [], { turn_type: 'proactive' }),
      ],
      thinking: true,
    });
    expect(screen.queryByText("Hi, I'm Mos.")).toBeNull();
    expect(screen.getByText('what is expiring?').querySelector('svg')).toBeTruthy();
    expect(screen.getByText('Your spinach expires today.').className).toBe('bubble bubble-mos');
    expect(screen.getByText('Mos is offline.').className).toBe('notice');
    const manage = screen.getByRole('link', { name: 'Manage usage' });
    expect(manage.getAttribute('href')).toBe('https://chatgpt.com/settings/usage');
    expect(manage.closest('.notice')?.textContent).toBe('Out of plan usage. Manage usage');
    expect(screen.getByText('Time is up for the pasta.').className).toBe('bubble bubble-mos bubble-proactive');
    expect(screen.getByLabelText('Mos is thinking')).toBeTruthy();
  });

  it("shows each card with its state: a card a newer version replaced is superseded", () => {
    const fake = fakeConversation({
      entries: [
        mos(1, '', [proposal(1)]),
        mos(2, '', [proposal(2), { type: 'step', session_id: 's', step_no: 1, step_text: 'Beat the eggs.' }]),
      ],
      proposals: { p1: 'committed' },
    });
    render(<Chat conversation={fake.conversation} pushToTalk={null} />);
    expect(screen.getByRole('article', { name: 'Add eggs v1' }).className).toContain('card-superseded');
    expect(screen.getByRole('article', { name: 'Add eggs v2' }).className).toContain('card-committed');
    expect(screen.getByRole('article', { name: 'Step 1' }).textContent).toContain('Beat the eggs.');
  });

  it('answers an options card with the option tapped, unless Mos is busy', () => {
    const options: Card = { type: 'options', code: 'needs_choice', ask: 'Which?', options: ['cherry tomato'] };
    const fake = fakeConversation({ entries: [mos(1, 'Which tomato?', [options])] });
    render(<Chat conversation={fake.conversation} pushToTalk={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'cherry tomato' }));
    expect(fake.sent).toEqual([['cherry tomato', 'text']]);
    fake.set({ thinking: true });
    expect((screen.getByRole('button', { name: 'cherry tomato' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('sends what was typed, trimmed, and nothing blank', () => {
    const fake = fakeConversation();
    render(<Chat conversation={fake.conversation} pushToTalk={null} />);
    const input = screen.getByLabelText('Message to Mos') as HTMLInputElement;
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(input.placeholder).toBe('Type to Mos');
    expect(screen.queryByLabelText('Hold to talk')).toBeNull();
    expect(send.disabled).toBe(true);
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.submit(input.form!);
    expect(fake.sent).toEqual([]);
    fireEvent.change(input, { target: { value: ' I bought eggs ' } });
    fireEvent.click(send);
    expect(fake.sent).toEqual([['I bought eggs', 'text']]);
    expect(input.value).toBe('');
  });

  it('talks while the mic or the space bar is held, but not while typing', () => {
    const pushToTalk = { start: vi.fn(), stop: vi.fn() };
    render(<Chat conversation={fakeConversation().conversation} pushToTalk={pushToTalk} />);
    const mic = screen.getByLabelText('Hold to talk');
    mic.setPointerCapture = () => {};

    fireEvent.pointerDown(mic, { pointerId: 1 });
    expect(mic.className).toBe('btn-talk is-pushing');
    fireEvent.pointerUp(mic);
    fireEvent.pointerDown(mic, { pointerId: 1 });
    fireEvent.pointerCancel(mic);
    expect(mic.className).toBe('btn-talk');

    fireEvent.keyDown(window, { code: 'Space' });
    fireEvent.keyDown(window, { code: 'Space', repeat: true });
    fireEvent.keyUp(window, { code: 'Space' });
    fireEvent.keyDown(window, { code: 'KeyA' });
    const input = screen.getByLabelText('Message to Mos');
    fireEvent.keyDown(input, { code: 'Space' });
    fireEvent.keyUp(input, { code: 'Space' });
    expect(pushToTalk.start).toHaveBeenCalledTimes(3);
    expect(pushToTalk.stop).toHaveBeenCalledTimes(3);
  });
});
