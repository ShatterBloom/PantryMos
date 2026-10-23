// The conversation as the page shows and speaks it: polling, the timeline, read-back acks and the
// open voice window, and the state of the cards on screen (IMPLEMENTATION_PLAN §8.5–§8.8).
import type { WindowKind } from './addressing.ts';
import { type Api, ApiError, type Message, type ProposalCard, type ProposalStatus, type ProposalView } from './api.ts';
import type { Speaker, Spoken } from './speaker.ts';

/** Where a ChatGPT plan's usage is managed. */
export const MANAGE_USAGE_URL = 'https://chatgpt.com/settings/usage';

export type Entry =
  | { kind: 'user'; key: string; text: string; mode: 'voice' | 'text' }
  | { kind: 'mos'; key: string; message: Message }
  | { kind: 'notice'; key: string; text: string; link?: { href: string; label: string } };

export interface ConversationState {
  entries: Entry[];
  /** A request is on its way: the user is waiting for Mos. */
  thinking: boolean;
  window: { kind: WindowKind; endsAt: number } | null;
  /** Card statuses, polled while pending. */
  proposals: Record<string, ProposalStatus>;
}

export interface ConversationHooks {
  /** A recipe step was delivered: a cooking session is going. */
  onStep?: () => void;
  /** A meal was recorded (its consumption card committed): the cooking session is over. */
  onMealRecorded?: () => void;
  /** The model refused the chat (signed out of ChatGPT, out of plan usage): its status changed. */
  onModelUnavailable?: () => void;
}

/** What survives a reload, per browser (localStorage): the conversation and what the user said in it. */
export interface Memory {
  load(): { conversationId: string; said: Array<{ afterMessageId: number; text: string; mode: 'voice' | 'text' }> } | null;
  save(value: { conversationId: string; said: Array<{ afterMessageId: number; text: string; mode: 'voice' | 'text' }> }): void;
}

export class Conversation {
  readonly conversationId: string;
  private state: ConversationState = { entries: [], thinking: false, window: null, proposals: {} };
  private readonly listeners = new Set<() => void>();
  private lastId = 0;
  private loaded = false;
  private said: Array<{ afterMessageId: number; text: string; mode: 'voice' | 'text' }>;
  private noticeSeq = 0;
  private polling: Promise<void> | null = null;
  private readonly api: Api;
  private readonly speaker: Speaker;
  private readonly memory: Memory;
  private readonly now: () => number;
  private readonly hooks: ConversationHooks;

  constructor(options: { api: Api; speaker: Speaker; memory: Memory; newId: () => string; now: () => number; hooks?: ConversationHooks }) {
    this.api = options.api;
    this.speaker = options.speaker;
    this.memory = options.memory;
    this.now = options.now;
    this.hooks = options.hooks ?? {};
    const remembered = this.memory.load();
    this.conversationId = remembered?.conversationId ?? options.newId();
    this.said = remembered?.said ?? [];
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): ConversationState => this.state;

  /** The window a bare phrase may answer, if it is still open. */
  openWindow(): WindowKind | null {
    const w = this.state.window;
    return w && w.endsAt > this.now() ? w.kind : null;
  }

  /** Sends what the user said or typed, then shows (and speaks) what came back. */
  async send(text: string, mode: 'voice' | 'text'): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === '') return;
    this.said.push({ afterMessageId: this.lastId, text: trimmed, mode });
    this.remember();
    this.set({
      entries: [...this.state.entries, { kind: 'user', key: `u${this.said.length}`, text: trimmed, mode }],
      thinking: true,
      // An answer closes the window on the agent too; nothing else may ride on it.
      window: null,
    });
    try {
      await this.api.chat(this.conversationId, trimmed, mode);
    } catch (err) {
      if (err instanceof ApiError && err.body.code === 'model_unavailable') {
        // Out of plan usage: managing it is the way on (Sign in with ChatGPT UI guidelines).
        this.notice(describe(err), err.body.reason === 'usage_limit' ? { href: MANAGE_USAGE_URL, label: 'Manage usage' } : undefined);
        this.hooks.onModelUnavailable?.();
      } else {
        this.notice(describe(err));
      }
    } finally {
      this.set({ thinking: false });
    }
    await this.poll();
  }

  /** Fetches new messages. The first poll shows history without speaking it. */
  poll(): Promise<void> {
    this.polling ??= this.fetchMessages().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  /** Re-reads the cards still pending, so buttons reflect commits made by voice or elsewhere. */
  async refreshProposals(): Promise<void> {
    const pending = Object.entries(this.state.proposals).filter(([, status]) => status === 'pending');
    for (const [id] of pending) {
      try {
        const view = await this.api.proposal(id);
        this.setProposal(id, view.status, view.kind);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) this.setProposal(id, 'expired');
      }
    }
  }

  /** A card as it stands now, with what may be edited on it. */
  loadProposal(id: string): Promise<ProposalView> {
    return this.api.proposal(id);
  }

  /** A card button. Returns an error message to show next to the card, or null. */
  act(card: ProposalCard, action: 'confirm' | 'reject' | 'regenerate'): Promise<string | null> {
    return this.cardAction(card, () =>
      action === 'confirm'
        ? this.api.confirm(card.proposal_id, card.version)
        : action === 'reject'
          ? this.api.reject(card.proposal_id, card.version)
          : this.api.regenerate(card.proposal_id),
    );
  }

  edit(card: ProposalCard, changes: unknown): Promise<string | null> {
    return this.cardAction(card, () => this.api.edit(card.proposal_id, card.version, changes));
  }

  /**
   * Runs a button action and reports its own outcome. Catching up afterwards (the card's state, the
   * acknowledgement message) is best-effort: the regular poll retries it.
   */
  private async cardAction(card: ProposalCard, run: () => Promise<unknown>): Promise<string | null> {
    let problem: string | null = null;
    try {
      await run();
    } catch (err) {
      problem = describe(err);
    }
    // A button answered: the voice question no longer stands (the agent closed its window too).
    this.set({ window: null });
    await this.refreshCard(card.proposal_id);
    await this.poll().catch(() => {});
    return problem;
  }

  /** Shows a line from the app itself (e.g. why the microphone stopped). */
  notice(text: string, link?: { href: string; label: string }): void {
    this.set({ entries: [...this.state.entries, { kind: 'notice', key: `n${++this.noticeSeq}`, text, ...(link ? { link } : {}) }] });
  }

  private async fetchMessages(): Promise<void> {
    let messages: Message[];
    try {
      messages = (await this.api.messages(this.conversationId, this.lastId)).messages;
    } catch (err) {
      // A new conversation has no messages yet, so the agent does not know it.
      if (!(err instanceof ApiError && err.status === 404)) throw err;
      messages = [];
    }
    const firstLoad = !this.loaded;
    this.loaded = true;
    if (messages.length === 0) {
      if (firstLoad) this.set({ entries: this.timeline([]) });
      return;
    }
    const entries = firstLoad ? this.timeline(messages) : [...this.state.entries, ...messages.map(mosEntry)];
    this.lastId = messages.at(-1)!.id;
    const proposals = { ...this.state.proposals };
    for (const m of messages) {
      for (const card of m.cards) if (card.type === 'proposal') proposals[card.proposal_id] ??= 'pending';
    }
    this.set({ entries, proposals });
    if (firstLoad) {
      await this.refreshProposals();
      return;
    }
    for (const m of messages) {
      if (m.cards.some((c) => c.type === 'step' && c.done !== true)) this.hooks.onStep?.();
      this.speaker.enqueue({ id: m.id, speech: m.speech, asks: m.voice_prompt !== null });
    }
  }

  /** Called by the Speaker: a message that asked something was heard in full, so open its window. */
  heard = async (message: Spoken): Promise<void> => {
    if (!message.asks) return;
    const asked = this.state.entries.find((e) => e.kind === 'mos' && e.message.id === message.id);
    const prompt = asked?.kind === 'mos' ? asked.message.voice_prompt : null;
    if (!prompt) return;
    try {
      const { window_ends_at } = await this.api.ack(this.conversationId, message.id);
      this.set({ window: { kind: prompt.kind, endsAt: Date.parse(window_ends_at) } });
    } catch (err) {
      // 409: a newer question was asked meanwhile; its own ack opens its window.
      if (!(err instanceof ApiError && err.status === 409)) this.notice(describe(err));
    }
  };

  private async refreshCard(id: string): Promise<void> {
    try {
      const view = await this.api.proposal(id);
      this.setProposal(id, view.status, view.kind);
    } catch {
      // The poll that follows shows what happened.
    }
  }

  private setProposal(id: string, status: ProposalStatus, kind?: string): void {
    const before = this.state.proposals[id];
    if (before === status) return;
    this.set({ proposals: { ...this.state.proposals, [id]: status } });
    if (status === 'committed' && before === 'pending' && kind === 'consume') this.hooks.onMealRecorded?.();
  }

  /** Mos's messages with what the user said between them, as remembered. */
  private timeline(messages: readonly Message[]): Entry[] {
    const entries: Entry[] = [];
    let said = 0;
    const flushSaid = (beforeId: number) => {
      while (said < this.said.length && this.said[said]!.afterMessageId < beforeId) {
        const s = this.said[said++]!;
        entries.push({ kind: 'user', key: `u${said}`, text: s.text, mode: s.mode });
      }
    };
    for (const m of messages) {
      flushSaid(m.id);
      entries.push(mosEntry(m));
    }
    flushSaid(Number.POSITIVE_INFINITY);
    return entries;
  }

  private remember(): void {
    this.memory.save({ conversationId: this.conversationId, said: this.said.slice(-100) });
  }

  private set(patch: Partial<ConversationState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

const mosEntry = (message: Message): Entry => ({ kind: 'mos', key: `m${message.id}`, message });

/** A failed request, in words for the user. */
export function describe(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.body.code === 'model_unavailable' && typeof err.body.message === 'string') return err.body.message;
    if (err.status === 429) return 'Too many requests. Wait a moment and try again.';
    if (err.status === 503) return 'Mos is still answering. Try again in a moment.';
    if (err.status === 409 && typeof err.body.message === 'string') return err.body.message;
    if (err.status >= 500) return 'Something went wrong. Please try again.';
    return err.message;
  }
  return 'Mos is unreachable. Check that the app is running.';
}
