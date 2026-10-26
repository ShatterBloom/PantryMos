// The page's conversation: history and polling, speaking and acks, the voice window, and card states.
import { beforeEach, describe, expect, it } from 'vitest';
import { type Api, ApiError, type InboxCard, type Message, type ProposalCard, type ProposalView } from '../../src/lib/api.ts';
import { Conversation, describe as describeError, type Memory } from '../../src/lib/conversation.ts';
import { Speaker, type Synth } from '../../src/lib/speaker.ts';

const message = (id: number, extra: Partial<Message> = {}): Message => ({
  id,
  turn_type: 'user',
  speech: `Message ${id}.`,
  cards: [],
  voice_prompt: null,
  session_id: null,
  step_no: null,
  created_at: '2026-10-21T00:00:00Z',
  ...extra,
});

const proposalCard = (id: string, kind: 'consume' | 'adjust' = 'adjust', version = 1): ProposalCard => ({
  type: 'proposal',
  proposal_id: id,
  version,
  kind,
  card: { title: 'T', lines: [], warnings: [], readback_text: 'R' },
  expires_at: '2026-10-21T01:00:00Z',
});

/** The agent as the conversation sees it. */
class FakeApi {
  posted: Message[] = [];
  views = new Map<string, Partial<ProposalView>>();
  chats: Array<{ text: string; mode: string }> = [];
  acks: number[] = [];
  ackError: ApiError | null = null;
  chatError: unknown = null;
  actions: string[] = [];
  actionError: ApiError | null = null;
  unknownConversation = false;
  messageCalls = 0;

  async chat(_c: string, text: string, mode: string) {
    if (this.chatError) throw this.chatError;
    this.chats.push({ text, mode });
    return { message_ids: [] };
  }
  async messages(_c: string, after: number) {
    this.messageCalls++;
    if (this.unknownConversation) throw new ApiError(404, { error: 'not_found' });
    return { messages: this.posted.filter((m) => m.id > after) };
  }
  async ack(_c: string, id: number) {
    if (this.ackError) throw this.ackError;
    this.acks.push(id);
    return { window_id: 'w', window_ends_at: new Date(30_000).toISOString() };
  }
  async proposal(id: string) {
    const view = this.views.get(id);
    if (!view) throw new ApiError(404, {});
    return view as ProposalView;
  }
  /** Cards other MCP clients left. */
  pending: InboxCard[] = [];
  inboxCalls = 0;
  async inbox() {
    this.inboxCalls++;
    return { proposals: this.pending };
  }
  /** The chat each card action named. */
  actionChats: string[] = [];
  private async action(name: string, conversationId: string) {
    this.actions.push(name);
    this.actionChats.push(conversationId);
    if (this.actionError) throw this.actionError;
    return {};
  }
  confirm = (id: string, v: number, c: string) => this.action(`confirm ${id} v${v}`, c);
  reject = (id: string, v: number, c: string) => this.action(`reject ${id} v${v}`, c);
  regenerate = (id: string, c: string) => this.action(`regenerate ${id}`, c);
  edit = (id: string, v: number, changes: unknown, c: string) => this.action(`edit ${id} v${v} ${JSON.stringify(changes)}`, c);
}

class InstantSynth implements Synth {
  said: string[] = [];
  speak(text: string, done: (outcome: 'completed') => void) {
    this.said.push(text);
    done('completed');
  }
  cancel() {}
}

class FakeMemory implements Memory {
  value: ReturnType<Memory['load']> = null;
  load = () => this.value;
  save = (v: NonNullable<ReturnType<Memory['load']>>) => {
    this.value = structuredClone(v);
  };
}

describe('Conversation', () => {
  let api: FakeApi;
  let synth: InstantSynth;
  let memory: FakeMemory;
  let now: number;
  let events: string[];
  let pendingAcks: Array<Promise<void>>;
  const build = () => {
    let conversation: Conversation | null = null;
    const speaker = new Speaker({ synth, onSpeaking: () => {}, onHeard: (m) => pendingAcks.push(conversation!.heard(m)) });
    conversation = new Conversation({
      api: api as unknown as Api,
      speaker,
      memory,
      newId: () => 'conv-1',
      now: () => now,
      hooks: { onStep: () => events.push('step'), onMealRecorded: () => events.push('meal'), onModelUnavailable: () => events.push('model') },
    });
    return conversation;
  };
  const settle = () => Promise.all(pendingAcks);

  beforeEach(() => {
    api = new FakeApi();
    synth = new InstantSynth();
    memory = new FakeMemory();
    now = 0;
    events = [];
    pendingAcks = [];
  });

  it('shows the history on load without speaking it, with what the user said in between', async () => {
    memory.value = {
      conversationId: 'conv-0',
      said: [
        { afterMessageId: 0, text: 'hello', mode: 'text' },
        { afterMessageId: 1, text: 'next', mode: 'voice' },
        { afterMessageId: 2, text: 'unanswered', mode: 'text' },
      ],
    };
    api.posted = [message(1), message(2, { cards: [proposalCard('p1')] })];
    api.views.set('p1', { status: 'committed', kind: 'adjust' });
    const conversation = build();
    expect(conversation.conversationId).toBe('conv-0');
    await conversation.poll();
    expect(conversation.getState().entries.map((e) => (e.kind === 'mos' ? `mos ${e.message.id}` : e.kind === 'user' ? e.text : e.text))).toEqual([
      'hello',
      'mos 1',
      'next',
      'mos 2',
      'unanswered',
    ]);
    expect(synth.said).toEqual([]);
    expect(conversation.getState().proposals).toEqual({ p1: 'committed' });
  });

  it('starts a new conversation, unknown to the agent until its first message', async () => {
    api.unknownConversation = true;
    const conversation = build();
    expect(conversation.conversationId).toBe('conv-1');
    await conversation.poll();
    expect(conversation.getState().entries).toEqual([]);
  });

  it('sends what the user said, then shows and speaks the reply; a step means cooking', async () => {
    const conversation = build();
    await conversation.poll();
    const listener: string[] = [];
    conversation.subscribe(() => listener.push(conversation.getState().thinking ? 'thinking' : 'idle'));
    api.posted.push(message(1, { speech: 'Step 1: crack the eggs.', cards: [{ type: 'step', session_id: 's', step_no: 1 }] }));
    await conversation.send('  cook the stir-fry ', 'voice');
    expect(api.chats).toEqual([{ text: 'cook the stir-fry', mode: 'voice' }]);
    expect(listener[0]).toBe('thinking');
    expect(conversation.getState().thinking).toBe(false);
    expect(synth.said).toEqual(['Step 1: crack the eggs.']);
    expect(events).toEqual(['step']);
    expect(memory.value).toEqual({ conversationId: 'conv-1', said: [{ afterMessageId: 0, text: 'cook the stir-fry', mode: 'voice' }] });

    await conversation.send('   ', 'text'); // nothing to send
    expect(api.chats).toHaveLength(1);

    // The last step is not the start of cooking.
    api.posted.push(message(2, { cards: [{ type: 'step', session_id: 's', step_no: 4, done: true }] }));
    await conversation.poll();
    expect(events).toEqual(['step']);
  });

  it('shows why a message could not be sent', async () => {
    const conversation = build();
    await conversation.poll();
    api.chatError = new ApiError(429, {});
    await conversation.send('hi', 'text');
    expect(conversation.getState().entries.at(-1)).toMatchObject({ kind: 'notice', text: 'Too many requests. Wait a moment and try again.' });
  });

  it("says why the model can't answer, links to the plan's usage when it ran out, and reports it", async () => {
    const conversation = build();
    await conversation.poll();
    api.chatError = new ApiError(503, { code: 'model_unavailable', reason: 'usage_limit', message: 'The ChatGPT plan has reached its usage limit for this app.' });
    await conversation.send('hi', 'text');
    expect(conversation.getState().entries.at(-1)).toEqual({
      kind: 'notice',
      key: expect.any(String),
      text: 'The ChatGPT plan has reached its usage limit for this app.',
      link: { href: 'https://chatgpt.com/settings/usage', label: 'Manage usage' },
    });
    api.chatError = new ApiError(503, { code: 'model_unavailable', reason: 'signed_out', message: 'Sign in with ChatGPT to talk to Mos.' });
    await conversation.send('hello?', 'text');
    expect(conversation.getState().entries.at(-1)).toEqual({ kind: 'notice', key: expect.any(String), text: 'Sign in with ChatGPT to talk to Mos.' });
    expect(events).toEqual(['model', 'model']);
  });

  it('opens the voice window once a question has been heard, until it ends or is answered', async () => {
    const conversation = build();
    await conversation.poll();
    api.posted.push(message(1, { voice_prompt: { kind: 'proposal_confirm', proposal_id: 'p1', version: 1 }, cards: [proposalCard('p1')] }));
    await conversation.poll();
    await settle();
    expect(api.acks).toEqual([1]);
    now = 29_999;
    expect(conversation.openWindow()).toBe('proposal_confirm');
    now = 30_000;
    expect(conversation.openWindow()).toBeNull();

    now = 0;
    expect(conversation.openWindow()).toBe('proposal_confirm');
    await conversation.send('yes', 'voice');
    expect(conversation.openWindow()).toBeNull();
  });

  it('acks only messages that asked, ignores a superseded ack, and reports other failures', async () => {
    const conversation = build();
    await conversation.poll();
    api.posted.push(message(1));
    await conversation.poll();
    await settle();
    expect(api.acks).toEqual([]);

    api.ackError = new ApiError(409, { error: 'superseded' });
    api.posted.push(message(2, { voice_prompt: { kind: 'timer_offer', label: 'eggs', seconds: 60, session_id: 's', step_no: 1 } }));
    await conversation.poll();
    await settle();
    expect(conversation.getState().entries.filter((e) => e.kind === 'notice')).toEqual([]);

    api.ackError = new ApiError(500, {});
    api.posted.push(message(3, { voice_prompt: { kind: 'timer_offer', label: 'eggs', seconds: 60, session_id: 's', step_no: 1 } }));
    await conversation.poll();
    await settle();
    expect(conversation.getState().entries.at(-1)).toMatchObject({ kind: 'notice', text: 'Something went wrong. Please try again.' });
    expect(conversation.openWindow()).toBeNull();
  });

  it('acts on cards, follows their state, and notices when the meal is recorded', async () => {
    const conversation = build();
    await conversation.poll();
    const card = proposalCard('p1', 'consume');
    api.posted.push(message(1, { cards: [card] }));
    await conversation.poll();
    expect(conversation.getState().proposals).toEqual({ p1: 'pending' });

    api.views.set('p1', { status: 'committed', kind: 'consume' });
    expect(await conversation.act(card, 'confirm')).toBeNull();
    expect(api.actions).toEqual(['confirm p1 v1']);
    expect(conversation.getState().proposals).toEqual({ p1: 'committed' });
    expect(events).toEqual(['meal']);
    await conversation.refreshProposals(); // no longer pending: not polled
    expect(events).toEqual(['meal']);

    // A card committed by voice is noticed by polling.
    const other = proposalCard('p2', 'consume');
    api.posted.push(message(2, { cards: [other] }));
    await conversation.poll();
    api.views.set('p2', { status: 'committed', kind: 'consume' });
    await conversation.refreshProposals();
    expect(events).toEqual(['meal', 'meal']);

    // A card that vanished reads as expired.
    api.posted.push(message(3, { cards: [proposalCard('p3')] }));
    await conversation.poll();
    await conversation.refreshProposals();
    expect(conversation.getState().proposals.p3).toBe('expired');
  });

  it('returns why a card action failed, and sends edits with the card version', async () => {
    const conversation = build();
    await conversation.poll();
    const card = proposalCard('p1', 'adjust', 2);
    api.views.set('p1', { status: 'pending', kind: 'adjust' });
    api.actionError = new ApiError(409, { code: 'stale_state', message: 'Things changed since this card was made.' });
    expect(await conversation.act(card, 'confirm')).toBe('Things changed since this card was made.');
    api.actionError = null;
    expect(await conversation.act(card, 'reject')).toBeNull();
    expect(await conversation.act(card, 'regenerate')).toBeNull();
    expect(await conversation.edit(card, { delta: -3 })).toBeNull();
    api.actionError = new ApiError(400, { message: 'Invalid changes for this card.' });
    expect(await conversation.edit(card, { delta: 'x' })).toBe('Invalid changes for this card.');
    api.views.delete('p1');
    expect(await conversation.act(card, 'confirm')).toBe('Invalid changes for this card.'); // a refresh that fails is ignored
    expect(api.actions.slice(0, 4)).toEqual(['confirm p1 v2', 'reject p1 v2', 'regenerate p1', 'edit p1 v2 {"delta":-3}']);
    expect(new Set(api.actionChats)).toEqual(new Set([conversation.conversationId]));
    expect((await conversation.loadProposal('p2').catch((e: unknown) => e)) instanceof ApiError).toBe(true);
  });

  it("keeps the inbox of other clients' cards, and re-reads it after a card is answered", async () => {
    const conversation = build();
    const inboxCard = (id: string, version = 1): InboxCard => ({
      proposal_id: id,
      kind: 'intake',
      status: 'pending',
      version,
      card: { title: 'Add milk', lines: ['1 l milk'], warnings: [], readback_text: 'R' },
      editable: null,
      expires_at: '2026-10-21T01:00:00Z',
      client: 'Claude Desktop',
    });
    let changes = 0;
    conversation.subscribe(() => changes++);
    api.pending = [inboxCard('x1')];
    await conversation.refreshInbox();
    expect(conversation.getState().inbox.map((c) => c.proposal_id)).toEqual(['x1']);
    // The same cards again: nothing to redraw.
    const seen = changes;
    await conversation.refreshInbox();
    expect(changes).toBe(seen);
    api.pending = [inboxCard('x1', 2)];
    await conversation.refreshInbox();
    expect(conversation.getState().inbox[0]!.version).toBe(2);

    api.views.set('x1', { status: 'committed', kind: 'intake' });
    api.pending = [];
    expect(await conversation.act({ type: 'proposal', ...inboxCard('x1', 2) }, 'confirm')).toBeNull();
    expect(api.actionChats).toEqual([conversation.conversationId]);
    expect(conversation.getState().inbox).toEqual([]);
  });

  it("reports the action's own outcome though catching up afterwards fails, and closes the window", async () => {
    const conversation = build();
    await conversation.poll();
    const card = proposalCard('p1');
    api.posted.push(message(1, { voice_prompt: { kind: 'proposal_confirm', proposal_id: 'p1', version: 1 }, cards: [card] }));
    await conversation.poll();
    await settle();
    expect(conversation.openWindow()).toBe('proposal_confirm');

    api.unknownConversation = false;
    api.messages = async () => {
      throw new ApiError(500, {});
    };
    expect(await conversation.act(card, 'reject')).toBeNull();
    api.actionError = new ApiError(409, { message: 'Things changed since this card was made.' });
    expect(await conversation.act(card, 'confirm')).toBe('Things changed since this card was made.');
    expect(conversation.openWindow()).toBeNull();
  });

  it('polls once at a time', async () => {
    const conversation = build();
    await Promise.all([conversation.poll(), conversation.poll()]);
    expect(api.messageCalls).toBe(1);
  });

  it('describes failures in words for the user', () => {
    expect(describeError(new ApiError(503, {}))).toBe('Mos is still answering. Try again in a moment.');
    expect(describeError(new ApiError(409, {}))).toBe('Request failed (409)');
    expect(describeError(new ApiError(404, { message: 'Not here.' }))).toBe('Not here.');
    expect(describeError(new TypeError('fetch failed'))).toBe('Mos is unreachable. Check that the app is running.');
  });
});
