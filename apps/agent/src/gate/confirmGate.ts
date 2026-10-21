// ConfirmGate (IMPLEMENTATION_PLAN §8.5): "the user confirmed" is decided here, by exact phrase match
// inside a voice window, never by the model. A gate turn makes no model call.
import { ACCEPT, CONFIRM, DECLINE, DISCARD, normalizeUtterance } from '@pantrymos/shared/voice';
import type { Pool } from '../db.ts';
import type { InternalClient, InternalResponse } from '../internalClient.ts';
import { insertEvent, type NewEvent } from '../store/events.ts';
import type { ConversationLease } from '../store/lease.ts';
import { insertOutbound, lastReadBackProposal, type VoicePrompt } from '../store/outbound.ts';
import { completeRequest } from '../store/requestLog.ts';
import { startTimer } from '../store/timers.ts';
import { closeOpenWindows, consumeWindow, openWindowFor, type VoiceWindow } from '../store/windows.ts';
import {
  ALREADY_SAVED,
  cardChanged,
  cardExpired,
  confirmed,
  DISCARDED,
  TIMER_DECLINED,
  timerStarted,
} from '../turn/speech.ts';
import { uuidv5 } from '../uuid.ts';

export interface GateDeps {
  pool: Pool;
  internal: InternalClient;
  userId: string;
}

export interface GateOutcome {
  messageId: number;
  speech: string;
}

/**
 * Handles a voice utterance when it answers the open window, or repeats a pending card after its
 * window closed (§8.5 step 6). Returns null when it is not the gate's to handle: the caller runs a
 * normal user turn.
 */
export async function runGate(
  deps: GateDeps,
  lease: ConversationLease,
  chatRequestId: string,
  text: string,
): Promise<GateOutcome | null> {
  const phrase = normalizeUtterance(text);
  const conversationId = lease.conversationId;
  const window = await openWindowFor(deps.pool, conversationId);

  let reply: GateReply | null = null;
  if (window?.kind === 'proposal_confirm' && (CONFIRM.has(phrase) || DISCARD.has(phrase))) {
    reply = await answerCard(deps, conversationId, chatRequestId, window, phrase);
  } else if (window?.kind === 'timer_offer' && (ACCEPT.has(phrase) || DECLINE.has(phrase))) {
    reply = { speech: ACCEPT.has(phrase) ? timerStarted(window.timer_spec.seconds) : TIMER_DECLINED, events: [], prompt: null };
  } else if (!window && (CONFIRM.has(phrase) || DISCARD.has(phrase))) {
    reply = await rereadPendingCard(deps, conversationId, chatRequestId, phrase);
  }
  if (!reply) return null;

  const final = reply;
  const messageId = await lease.write(async (tx) => {
    if (window) await consumeWindow(tx, window.id);
    if (window?.kind === 'timer_offer' && ACCEPT.has(phrase)) {
      const spec = window.timer_spec;
      await startTimer(tx, {
        conversationId,
        requestId: uuidv5(chatRequestId, 'timer'),
        label: spec.label,
        seconds: spec.seconds,
        sessionId: spec.session_id,
        stepNo: spec.step_no,
      });
    }
    for (const e of final.events) await insertEvent(tx, e);
    if (final.prompt) await closeOpenWindows(tx, conversationId);
    const id = await insertOutbound(tx, {
      conversationId,
      turnType: 'gate',
      speech: final.speech,
      cards: final.card ? [final.card] : [],
      voicePrompt: final.prompt,
    });
    await completeRequest(tx, conversationId, chatRequestId, { status: 200, body: { message_ids: [id] } });
    return id;
  });
  return { messageId, speech: final.speech };
}

interface GateReply {
  speech: string;
  events: NewEvent[];
  /** Set when the reply reads a card back, asking for a new confirmation. */
  prompt: VoicePrompt | null;
  card?: { type: 'proposal'; [key: string]: unknown };
}

/** §8.5 step 3: confirm or discard exactly the version that was read back. */
async function answerCard(
  deps: GateDeps,
  conversationId: string,
  chatRequestId: string,
  window: Extract<VoiceWindow, { kind: 'proposal_confirm' }>,
  phrase: string,
): Promise<GateReply> {
  const requestId = uuidv5(chatRequestId, 'gate');
  const { proposal_id, version } = window;
  const event = (kind: NewEvent['kind'], outcome: string, extra: Record<string, unknown> = {}): NewEvent => ({
    conversationId,
    kind,
    payload: { proposal_id, version, ...extra },
    dedupeKey: `proposal:${proposal_id}:v${version}:${outcome}`,
    // The gate already said the result; the model hears of it in the next user turn.
    triggersTurn: false,
  });

  if (DISCARD.has(phrase)) {
    const res = await deps.internal.reject(proposal_id, { version, request_id: requestId });
    if (res.status === 200) return { speech: DISCARDED, events: [event('proposal_rejected', 'rejected', { kind: res.body.kind })], prompt: null };
    return failure(deps, res, proposal_id);
  }

  const res = await deps.internal.confirm(proposal_id, {
    version,
    user_id: deps.userId,
    channel: 'voice_rule',
    utterance: phrase,
    request_id: requestId,
  });
  if (res.status === 200) {
    const kind = res.body.kind as string;
    return { speech: confirmed(kind), events: [event('proposal_committed', 'committed', { kind, operation_id: res.body.operation_id, summary: res.body.summary })], prompt: null };
  }
  if (res.body.code === 'stale_state') {
    const stale = event('proposal_stale', 'stale', { reason: res.body.reason });
    const regen = await deps.internal.regenerate(proposal_id, { request_id: uuidv5(chatRequestId, 'regen') });
    if (regen.status !== 200) return { speech: String(regen.body.message ?? cardExpired), events: [stale], prompt: null };
    const fresh = await readBack(deps, regen.body.proposal_id as string, cardChanged);
    return fresh ? { ...fresh, events: [stale] } : { speech: cardExpired, events: [stale], prompt: null };
  }
  return failure(deps, res, proposal_id);
}

async function failure(deps: GateDeps, res: InternalResponse, proposalId: string): Promise<GateReply> {
  switch (res.body.code) {
    case 'stale_proposal': {
      // A newer version exists: read that one back (§8.5 step 3).
      const current = await readBack(deps, proposalId, cardChanged);
      if (current) return { ...current, events: [] };
      return { speech: cardExpired, events: [], prompt: null };
    }
    case 'already_committed':
      return { speech: ALREADY_SAVED, events: [], prompt: null };
    case 'expired':
      return { speech: cardExpired, events: [], prompt: null };
    default:
      return { speech: String(res.body.message ?? cardExpired), events: [], prompt: null };
  }
}

/** The current version of a pending card, read back with a fresh confirm prompt; null when it is no longer pending. */
async function readBack(
  deps: GateDeps,
  proposalId: string,
  wrap: (readback: string) => string = (r) => r,
): Promise<Omit<GateReply, 'events'> | null> {
  const view = await deps.internal.view(proposalId);
  if (view?.status !== 'pending') return null;
  return {
    speech: wrap(view.card.readback_text),
    prompt: { kind: 'proposal_confirm', proposal_id: view.proposal_id, version: view.version },
    card: { type: 'proposal', proposal_id: view.proposal_id, version: view.version, kind: view.kind, card: view.card, expires_at: view.expires_at },
  };
}

/** §8.5 step 6: a bare confirm or discard with no open window re-reads the card if it is still pending. */
async function rereadPendingCard(
  deps: GateDeps,
  conversationId: string,
  chatRequestId: string,
  phrase: string,
): Promise<GateReply | null> {
  const proposalId = await lastReadBackProposal(deps.pool, conversationId);
  const current = proposalId ? await readBack(deps, proposalId) : null;
  if (!current) return null;
  const prompt = current.prompt as Extract<VoicePrompt, { kind: 'proposal_confirm' }>;
  return {
    ...current,
    events: [
      {
        conversationId,
        kind: 'window_expired',
        payload: { utterance: phrase, proposal_id: prompt.proposal_id, version: prompt.version },
        dedupeKey: `window_expired:${chatRequestId}`,
        triggersTurn: false,
      },
    ],
  };
}
