// @vitest-environment jsdom
// Cards other MCP clients made, waiting above the chat until confirmed or discarded.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { InboxCard, ProposalCard } from '../../src/lib/api.ts';
import type { Conversation, ConversationState } from '../../src/lib/conversation.ts';
import { Inbox } from '../../src/ui/Inbox.tsx';

afterEach(cleanup);

const inboxCard = (id: string, client: string | null): InboxCard => ({
  proposal_id: id,
  kind: 'intake',
  status: 'pending',
  version: 1,
  card: { title: 'Add milk', lines: ['1 l milk'], warnings: [], readback_text: "I'll add 1 l of milk." },
  editable: null,
  expires_at: '2026-10-21T01:00:00Z',
  client,
});

function fakeConversation(inbox: InboxCard[]) {
  let state: ConversationState = { entries: [], thinking: false, window: null, proposals: {}, inbox };
  const listeners = new Set<() => void>();
  const acted: Array<[ProposalCard, string]> = [];
  const conversation = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    act: async (card: ProposalCard, action: string) => {
      acted.push([card, action]);
      state = { ...state, inbox: [] };
      for (const l of listeners) l();
      return null;
    },
  };
  return { conversation: conversation as unknown as Conversation, acted };
}

describe('Inbox', () => {
  it('shows nothing while no other app is waiting', () => {
    const { container } = render(<Inbox conversation={fakeConversation([]).conversation} />);
    expect(container.innerHTML).toBe('');
  });

  it('names the app each card came from, and confirms one as a card', async () => {
    const fake = fakeConversation([inboxCard('x1', 'Claude Desktop'), inboxCard('x2', null)]);
    render(<Inbox conversation={fake.conversation} />);
    expect(screen.getByRole('region', { name: 'Cards from other apps' })).toBeTruthy();
    expect(screen.getByText('From Claude Desktop')).toBeTruthy();
    expect(screen.getByText('From another app')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Confirm' })[0]!);
    });
    expect(fake.acted).toEqual([
      [{ type: 'proposal', proposal_id: 'x1', version: 1, kind: 'intake', card: inboxCard('x1', null).card, expires_at: '2026-10-21T01:00:00Z' }, 'confirm'],
    ]);
    expect(screen.queryByRole('region', { name: 'Cards from other apps' })).toBeNull();
  });
});
