// Cards other MCP clients made (a desktop assistant, say): they change nothing until confirmed here.
import { useSyncExternalStore } from 'react';
import type { InboxCard, ProposalCard } from '../lib/api.ts';
import type { Conversation } from '../lib/conversation.ts';
import { ProposalCardView } from './Cards.tsx';

const asCard = (c: InboxCard): ProposalCard => ({
  type: 'proposal',
  proposal_id: c.proposal_id,
  version: c.version,
  kind: c.kind,
  card: c.card,
  expires_at: c.expires_at,
});

export function Inbox({ conversation }: { conversation: Conversation }) {
  const { inbox } = useSyncExternalStore(conversation.subscribe, conversation.getState);
  if (inbox.length === 0) return null;
  return (
    <section className="inbox" aria-label="Cards from other apps">
      <h2 className="inbox-title">Waiting for you to confirm</h2>
      {inbox.map((c) => (
        <div key={`${c.proposal_id}-v${c.version}`} className="inbox-item">
          <p className="inbox-from">From {c.client ?? 'another app'}</p>
          <ProposalCardView card={asCard(c)} status="pending" conversation={conversation} />
        </div>
      ))}
    </section>
  );
}
