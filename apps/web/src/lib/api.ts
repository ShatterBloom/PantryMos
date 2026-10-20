// The agent's /api, as the web app uses it (IMPLEMENTATION_PLAN §8.8).

export type VoicePrompt =
  | { kind: 'proposal_confirm'; proposal_id: string; version: number }
  | { kind: 'timer_offer'; label: string; seconds: number; session_id: string; step_no: number };

export interface ProposalCard {
  type: 'proposal';
  proposal_id: string;
  version: number;
  kind: ProposalKind;
  card: { title: string; lines: string[]; warnings: string[]; readback_text: string };
  expires_at: string;
}
export interface StepCard {
  type: 'step';
  session_id: string;
  step_no: number;
  total_steps?: number;
  step_text?: string;
  timer_seconds?: number | null;
  timer_label?: string | null;
  done?: boolean;
}
export interface OptionsCard {
  type: 'options';
  code: string;
  ask: string | null;
  options: unknown[];
}
export type Card = ProposalCard | StepCard | OptionsCard;

export interface Message {
  id: number;
  turn_type: 'user' | 'proactive' | 'gate';
  speech: string;
  cards: Card[];
  voice_prompt: VoicePrompt | null;
  session_id: string | null;
  step_no: number | null;
  created_at: string;
}

export type ProposalKind = 'intake' | 'consume' | 'revise_consumption' | 'adjust' | 'undo';
export type ProposalStatus = 'pending' | 'committed' | 'rejected' | 'superseded' | 'stale' | 'expired';

export interface EditableLine {
  item: string;
  quantity: number;
  unit: string;
}
export type Editable =
  | { type: 'items'; items: Array<Record<string, unknown> & { name: string; quantity?: number }>; lines: EditableLine[] }
  | { type: 'lines'; field: 'overrides' | 'usage'; lines: EditableLine[] }
  | { type: 'amount'; field: 'delta' | 'set_quantity'; item: string; value: number; unit: string }
  | null;

export interface ProposalView {
  proposal_id: string;
  kind: ProposalKind;
  status: ProposalStatus;
  version: number;
  card: ProposalCard['card'];
  editable: Editable;
  expires_at: string;
}

export interface Timer {
  id: string;
  label: string;
  seconds: number;
  status: 'running' | 'paused';
  remaining_seconds: number | null;
}

export interface Inventory {
  today: string;
  items: Array<{
    item: string;
    total: number;
    unit: string;
    batches: Array<{ batch_id: string; quantity: number; date_label: string; priority_source: 'package' | 'estimate' }>;
  }>;
  shopping_list: Array<{ id: string; item: string; quantity: number | null; unit: string | null; source: 'manual' | 'shortfall' }>;
}

export interface LedgerOperation {
  operation_id: string;
  kind: ProposalKind;
  summary: string;
  changes: Array<{ item: string; delta: number; unit: string }>;
  proposal_version: number;
  confirmed: { channel: 'ui_click' | 'voice_rule'; utterance: string | null; user_id: string };
  reverted_by: string | null;
  reverts_operation_ids: string[];
  created_at: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body.message === 'string' ? body.message : `Request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiOptions {
  fetch: Fetch;
  /** Asked when the session is missing and a passcode is needed; null gives up. */
  passcode: () => Promise<string | null>;
  newId: () => string;
}

export class Api {
  private readonly options: ApiOptions;
  private signingIn: Promise<void> | null = null;

  constructor(options: ApiOptions) {
    this.options = options;
  }

  /** Signs in if needed (§11.4): locally without a passcode, deployed with one. */
  async ensureSession(): Promise<void> {
    const session = await this.request<{ user_id: string | null; passcode_required: boolean }>('GET', '/api/session');
    if (session.user_id) return;
    await this.signIn(session.passcode_required);
  }

  chat(conversationId: string, text: string, inputMode: 'voice' | 'text', requestId = this.options.newId()) {
    return this.request<{ message_ids: number[] }>('POST', '/api/chat', {
      conversation_id: conversationId,
      request_id: requestId,
      text,
      input_mode: inputMode,
    });
  }

  messages(conversationId: string, after: number) {
    return this.request<{ messages: Message[] }>('GET', `/api/messages?conversation_id=${conversationId}&after=${after}`);
  }

  ack(conversationId: string, messageId: number) {
    return this.request<{ window_id: string; window_ends_at: string }>('POST', '/api/voice-windows/ack', {
      conversation_id: conversationId,
      message_id: messageId,
      request_id: this.options.newId(),
    });
  }

  proposal(id: string) {
    return this.request<ProposalView>('GET', `/api/proposals/${id}`);
  }

  confirm(id: string, version: number) {
    return this.request<Record<string, unknown>>('POST', `/api/proposals/${id}/confirm`, { version, request_id: this.options.newId() });
  }

  reject(id: string, version: number) {
    return this.request<Record<string, unknown>>('POST', `/api/proposals/${id}/reject`, { version, request_id: this.options.newId() });
  }

  edit(id: string, baseVersion: number, changes: unknown) {
    return this.request<Record<string, unknown>>('PATCH', `/api/proposals/${id}`, {
      base_version: baseVersion,
      changes,
      request_id: this.options.newId(),
    });
  }

  regenerate(id: string) {
    return this.request<Record<string, unknown>>('POST', `/api/proposals/${id}/regenerate`, { request_id: this.options.newId() });
  }

  timers(conversationId: string) {
    return this.request<{ timers: Timer[] }>('GET', `/api/timers?conversation_id=${conversationId}`);
  }

  inventory() {
    return this.request<Inventory>('GET', '/api/inventory');
  }

  ledger(limit = 50) {
    return this.request<{ operations: LedgerOperation[] }>('GET', `/api/ledger?limit=${limit}`);
  }

  /** One request; a lost session (401) signs in again and retries once. */
  private async request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, retried = false): Promise<T> {
    const res = await this.options.fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    const parsed = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    if (res.status === 401 && !retried && path !== '/api/session') {
      await this.signIn(null);
      return this.request<T>(method, path, body, true);
    }
    if (!res.ok) throw new ApiError(res.status, parsed);
    return parsed as T;
  }

  /** One sign-in at a time, however many requests found the session gone. */
  private signIn(passcodeRequired: boolean | null): Promise<void> {
    this.signingIn ??= (async () => {
      try {
        const required =
          passcodeRequired ?? (await this.request<{ passcode_required: boolean }>('GET', '/api/session')).passcode_required;
        const passcode = required ? await this.options.passcode() : undefined;
        if (passcode === null) throw new ApiError(401, { message: 'Sign-in needs the passcode.' });
        await this.request('POST', '/api/session', passcode === undefined ? {} : { passcode });
      } finally {
        this.signingIn = null;
      }
    })();
    return this.signingIn;
  }
}
