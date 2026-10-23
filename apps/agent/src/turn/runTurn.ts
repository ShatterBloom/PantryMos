// The turn loop (IMPLEMENTATION_PLAN §8.2): model calls, write-ahead tool calls, resume, and the outbound message.
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Pool } from '../db.ts';
import { type ContentBlock, isText, isToolResult, isToolUse, type Message, type ModelClient, type ToolUse } from '../model/types.ts';
import { appendMessage, loadMessages } from '../store/conversations.ts';
import { type AppEvent, drainForUserTurn, markDelivered } from '../store/events.ts';
import type { ConversationLease } from '../store/lease.ts';
import { type Card, insertOutbound, lastDeliveredStep, type VoicePrompt } from '../store/outbound.ts';
import { completeRequest, markStarted, type TurnSnapshot } from '../store/requestLog.ts';
import { stepHasTimer } from '../store/timers.ts';
import { callsByToolUse, callsOfTurn, insertPending, markDone, type ToolCallRow, type ToolOutput, type TurnOwner } from '../store/toolCalls.ts';
import { closeOpenWindows } from '../store/windows.ts';
import { isLocalTool, localToolSpecs, runLocalTool } from '../tools/local.ts';
import { callMcpTool, mcpToolSpecs } from '../tools/mcp.ts';
import { uuidv5 } from '../uuid.ts';
import { ground, NO_REPLY, withoutImpactTalk, withoutQuestions, withoutRecital, withoutStepRecital } from './grounding.ts';
import { SYSTEM_PROMPT } from './prompt.ts';
import { eventBlock, fallbackSpeech, NOT_CHANGED, TURN_FAILED, timerOffer } from './speech.ts';

/** §8.1: the single source of truth for iteration caps (also §11.5). */
export const MAX_ITERATIONS = { user: 8, proactive: 3 } as const;

/**
 * §8.1: what a proactive turn may call. Timers change only when the user asks, so of the timer
 * tools only list_timers: the prompt says so too, but the prompt is not a permission boundary.
 */
const PROACTIVE_TOOLS: ReadonlySet<string> = new Set([
  'list_inventory',
  'expiring_soon',
  'suggest_recipes',
  'get_session',
  'list_recent_operations',
  'propose_consumption',
  'list_timers',
]);

/**
 * A fired timer is announced, never acted on (§9.6 G5, G8): a turn for timers alone may only read.
 * In the eval, Nova proposed the consumption when a step timer fired.
 */
const TIMER_TOOLS: ReadonlySet<string> = new Set([...PROACTIVE_TOOLS].filter((t) => !t.startsWith('propose_')));

/**
 * Retries of a reply with nothing in it: no text and no tool use, e.g. when Nova answered with only
 * `<thinking>`, which the adapter strips. Each retry nudges the model; after them the turn says a
 * templated fallback instead of nothing.
 */
export const EMPTY_REPLY_RETRIES = 2;
export const EMPTY_REPLY_NUDGE = '[app] Your last reply had nothing for the user. Reply to the user now.';

/** Tools whose success output delivers a recipe step to the user. */
const STEP_TOOLS: ReadonlySet<string> = new Set(['start_cooking', 'next_step', 'get_session']);

export interface TurnDeps {
  pool: Pool;
  model: ModelClient;
  /** A connected MCP client for this turn; closed when the turn ends. */
  connectMcp: () => Promise<Client>;
}

export type TurnTrigger =
  | {
      type: 'user';
      chatRequestId: string;
      text: string;
      /** Set when a crashed attempt is resumed (§5.2). */
      resume: { started: boolean; snapshot: TurnSnapshot | null } | null;
    }
  | { type: 'proactive'; events: Array<AppEvent & { delivered: boolean }> };

export interface TraceEntry {
  name: string;
  input: Record<string, unknown>;
  isError: boolean;
  output: Record<string, unknown>;
}

export interface TurnResult {
  messageId: number;
  speech: string;
  /** §8.2: the tool trace for the dev panel and the eval log. */
  trace: TraceEntry[];
}

export async function runTurn(deps: TurnDeps, lease: ConversationLease, trigger: TurnTrigger): Promise<TurnResult> {
  const conversationId = lease.conversationId;
  const owner: TurnOwner =
    trigger.type === 'user' ? { chatRequestId: trigger.chatRequestId } : { eventIds: trigger.events.map((e) => e.id) };
  const proactiveTools =
    trigger.type === 'proactive' && trigger.events.every((e) => e.kind === 'timer_fired') ? TIMER_TOOLS : PROACTIVE_TOOLS;
  const allowed = (name: string) => trigger.type === 'user' || proactiveTools.has(name);

  const mcp = await deps.connectMcp();
  try {
    const tools = [...(await mcpToolSpecs(mcp)), ...localToolSpecs()].filter((t) => allowed(t.name));
    const snapshot = await startTurn(lease, trigger);

    const execute = async (call: ToolCallRow): Promise<ToolOutput> => {
      if (!allowed(call.name)) return toolError('tool_not_allowed', `${call.name} is not available in this turn.`);
      if (call.name.startsWith('propose_') && (await cardOfTurn(deps.pool, conversationId, owner, call.tool_use_id))) {
        // A message reads back one card, and "confirm" answers one (§8.5).
        return toolError(
          'one_card_per_turn',
          'This turn already made a card, and the user can confirm only one at a time. Let the user answer that card; make this one in a later turn.',
        );
      }
      if (call.name === 'next_step' && call.final_input.expected_step === undefined) {
        return toolError('no_step_heard', 'No recipe step has been read to the user yet. Call get_session and read the current step first.');
      }
      if (call.name === 'next_step' && trigger.type === 'user' && (await stepsTaken(deps.pool, conversationId, owner, call.tool_use_id)) >= nextsSaid(trigger.text)) {
        // In the eval Nova answered one "next" with six next_step calls, skipping to the end.
        return toolError('one_step_per_next', 'The user asked for one step per "next". Let them hear this step first.');
      }
      if (call.name === 'propose_adjustment' && call.final_input.share !== undefined && trigger.type === 'user' && !SHARE_SAID.test(lastUserWords(messages, 2))) {
        // In the eval Nova made "I spilled 300 ml of milk" half the milk (P12).
        return toolError(
          'no_share_said',
          'The user named no share like "half" or "a third". Give the amount they said as delta, e.g. -300 for "300 ml"; if they said none, ask how much.',
        );
      }
      if (call.name === 'propose_consumption' && (await stepDelivered(deps.pool, conversationId, owner))) {
        // In the eval Nova moved on to the last step and proposed the meal in the same turn (P9).
        return toolError('step_not_heard', 'This turn gave the user a new step to cook. Let them hear it; propose the meal when they say "next" or that they are done.');
      }
      if (isLocalTool(call.name)) {
        const name = call.name;
        return lease.write((tx) => runLocalTool(tx, conversationId, name, call.final_input, call.request_id));
      }
      return callMcpTool(mcp, call.name, call.final_input, { requestId: call.request_id, conversationId });
    };

    /**
     * Runs the toolUses of one assistant message in order, each written ahead as `pending` with its
     * final input, then appends their results. On resume, done calls are not re-run and pending ones
     * re-run with their recorded input and request_id (§5.2).
     */
    const runToolUses = async (uses: ToolUse[]) => {
      const results: ContentBlock[] = [];
      for (const use of uses) {
        let call = (await callsByToolUse(deps.pool, conversationId, [use.toolUseId])).get(use.toolUseId);
        if (!call) {
          const finalInput = await injectInputs(deps.pool, conversationId, owner, use, snapshot, trigger.type === 'user' ? trigger.text : null);
          await lease.write((tx) =>
            insertPending(tx, conversationId, owner, {
              toolUseId: use.toolUseId,
              name: use.name,
              finalInput,
              requestId: uuidv5(conversationId, use.toolUseId),
            }),
          );
          call = (await callsByToolUse(deps.pool, conversationId, [use.toolUseId])).get(use.toolUseId)!;
        }
        let result = call.result;
        if (call.status === 'pending' || !result) {
          result = await execute(call);
          const done = result;
          await lease.write((tx) => markDone(tx, conversationId, use.toolUseId, done));
        }
        results.push({
          toolResult: { toolUseId: use.toolUseId, status: result.isError ? 'error' : 'success', content: [{ json: result.data }] },
        });
      }
      await lease.write((tx) => appendMessage(tx, conversationId, 'user', results));
    };

    /**
     * §8.3 guardrails on the final reply, before it is said or kept (grounding.ts). A reply that was
     * nothing but a false claim of a change becomes a templated line, unless a card is read back.
     */
    const groundReply = async (content: ContentBlock[]): Promise<ContentBlock[]> => {
      const committed = heardCommit(messages);
      const calls = await callsOfTurn(deps.pool, conversationId, owner);
      const timerStarted = calls.some((c) => (c.name === 'start_timer' || c.name === 'resume_timer') && c.result !== null && !c.result.isError);
      let claims = 0;
      const grounded = content.map((b) => {
        if (!isText(b)) return b;
        const g = ground(b.text, { committed, timerStarted });
        claims += g.claims.length;
        return { text: g.text };
      });
      const silent = !grounded.some((b) => isText(b) && b.text !== '');
      if (claims > 0 && silent && !(await cardOfTurn(deps.pool, conversationId, owner, ''))) return [{ text: NOT_CHANGED }];
      return grounded;
    };

    let messages = await loadMessages(deps.pool, conversationId);
    // Resume: an assistant message whose toolUses never got their results appended.
    const last = messages.at(-1);
    if (last?.role === 'assistant' && last.content.some(isToolUse)) {
      await runToolUses(last.content.filter(isToolUse).map((b) => b.toolUse));
      messages = await loadMessages(deps.pool, conversationId);
    }

    for (let i = 0; i < MAX_ITERATIONS[trigger.type] && messages.at(-1)?.role !== 'assistant'; i++) {
      const request = { system: SYSTEM_PROMPT, messages: toModelMessages(messages), tools };
      let reply = await deps.model.converse(request);
      for (let retry = 0; retry < EMPTY_REPLY_RETRIES && reply.content.length === 0; retry++) {
        reply = await deps.model.converse({ ...request, messages: withNudge(request.messages) });
      }
      let content: ContentBlock[] = reply.content.length > 0 ? reply.content : [{ text: '' }];
      if (!content.some(isToolUse)) content = await groundReply(content);
      await lease.write((tx) => appendMessage(tx, conversationId, 'assistant', content));
      const uses = content.filter(isToolUse).map((b) => b.toolUse);
      if (uses.length > 0) await runToolUses(uses);
      messages = await loadMessages(deps.pool, conversationId);
    }

    return await finishTurn(deps.pool, lease, trigger, owner, messages);
  } finally {
    await mcp.close().catch(() => {});
  }
}

/**
 * Persists the turn's input once (§8.2): pending app events as `[app event]` blocks, plus the user's
 * text, and the step snapshot that `expected_step` is injected from. Returns the snapshot.
 */
async function startTurn(lease: ConversationLease, trigger: TurnTrigger): Promise<TurnSnapshot | null> {
  const conversationId = lease.conversationId;
  if (trigger.type === 'user' && trigger.resume?.started) return trigger.resume.snapshot;
  if (trigger.type === 'proactive' && trigger.events.every((e) => e.delivered)) return null;
  return lease.write(async (tx) => {
    let snapshot: TurnSnapshot | null = null;
    let events: Array<Pick<AppEvent, 'kind' | 'payload'>>;
    if (trigger.type === 'user') {
      // The user moved on: a question still open is no longer the one a later "yes" answers (§8.5).
      await closeOpenWindows(tx, conversationId);
      snapshot = await lastDeliveredStep(tx, conversationId);
      events = await drainForUserTurn(tx, conversationId);
    } else {
      events = trigger.events;
      await markDelivered(tx, trigger.events.map((e) => e.id));
    }
    const blocks: ContentBlock[] = events.map((e) => ({ text: eventBlock(e) }));
    if (trigger.type === 'user') blocks.push({ text: trigger.text });
    await appendMessage(tx, conversationId, 'user', blocks);
    if (trigger.type === 'user') await markStarted(tx, conversationId, trigger.chatRequestId, snapshot);
    return snapshot;
  });
}

/**
 * Inputs the app sets, not the model:
 * - §7.4 `expected_step`: the step the user heard when the turn began, moved on by each step this
 *   turn delivered through start_cooking or a successful next_step ("next, next");
 * - `chosen_by_user` on a substitution: whether the user's own words this turn name the substitute;
 * - `scope_chosen_by_user` on an undo: whether the user's words this turn say which, the correction
 *   or the whole meal; otherwise the server asks (PRD FR-21).
 */
async function injectInputs(
  pool: Pool,
  conversationId: string,
  owner: TurnOwner,
  use: ToolUse,
  snapshot: TurnSnapshot | null,
  userText: string | null,
): Promise<Record<string, unknown>> {
  const input = { ...((use.input ?? {}) as Record<string, unknown>) };
  const named = (item: unknown) => userText !== null && typeof item === 'string' && mentions(userText, item);
  if (use.name === 'start_cooking' && Array.isArray(input.substitutions)) {
    input.substitutions = input.substitutions.map((s: Record<string, unknown>) => ({ ...s, chosen_by_user: named(s.to_item) }));
  }
  if (use.name === 'substitute' && input.to_item !== undefined) input.chosen_by_user = named(input.to_item);
  if (use.name === 'propose_undo') input.scope_chosen_by_user = userText !== null && UNDO_SCOPE_SAID.test(userText);
  if (use.name !== 'next_step') return input;
  delete input.expected_step;
  let step = snapshot?.step_no;
  for (const call of await callsOfTurn(pool, conversationId, owner)) {
    if ((call.name === 'start_cooking' || call.name === 'next_step') && call.result && !call.result.isError) {
      step = call.result.data.step_no as number;
    }
  }
  return step === undefined ? input : { ...input, expected_step: step };
}

/** Builds and stores the outbound message: model speech, cards, read-backs and the timer offer (§8.2, §8.5, §8.6). */
async function finishTurn(
  pool: Pool,
  lease: ConversationLease,
  trigger: TurnTrigger,
  owner: TurnOwner,
  messages: Message[],
): Promise<TurnResult> {
  const conversationId = lease.conversationId;
  const calls = (await callsOfTurn(pool, conversationId, owner)).filter((c) => c.result !== null);
  const last = messages.at(-1);
  // Out of iterations: a proactive turn says its events' templated lines below, as the user asked
  // nothing (eval G5: Nova kept reading the session when a timer fired).
  let speech =
    last?.role === 'assistant'
      ? last.content
          .filter(isText)
          .map((b) => b.text.trim())
          .filter(Boolean)
          .join(' ')
      : trigger.type === 'user'
        ? "Sorry, that took too many steps. Let's try something simpler."
        : '';

  const cards: Card[] = [];
  let proposal: Record<string, unknown> | null = null;
  let step: { session_id: string; step_no: number } | null = null;
  let stepText: string | null = null;
  let stepSpeech: string | null = null;
  let offer: VoicePrompt | null = null;
  for (const call of calls) {
    const { isError, data } = call.result!;
    if (isError) {
      if (Array.isArray(data.options)) cards.push({ type: 'options', code: data.code, ask: data.ask ?? null, options: data.options });
      continue;
    }
    if (call.name.startsWith('propose_')) {
      proposal = data;
    } else if (STEP_TOOLS.has(call.name) && typeof data.step_no === 'number') {
      if (call.name === 'get_session' && !['cooking', 'awaiting_confirmation'].includes(data.state as string)) continue;
      step = { session_id: data.session_id as string, step_no: data.step_no };
      if (call.name === 'get_session') continue;
      cards.push({ type: 'step', ...pick(data, ['session_id', 'step_no', 'total_steps', 'step_text', 'timer_seconds', 'timer_label', 'done']) });
      // The app reads the step from the recipe; the model may not (grounding.ts).
      stepText = data.done !== true && typeof data.step_text === 'string' ? data.step_text : null;
      stepSpeech = stepText === null ? null : `Step ${data.step_no}: ${stepText}`;
      offer =
        typeof data.timer_seconds === 'number' && data.done !== true
          ? {
              kind: 'timer_offer',
              label: (data.timer_label as string | null) ?? `step ${data.step_no}`,
              seconds: data.timer_seconds,
              session_id: data.session_id as string,
              step_no: data.step_no,
            }
          : null;
    }
  }

  // What the app says follows the model's speech: the step, then the card's read-back, the timer
  // offer or the model's cue to say "next".
  let cue: string | null = null;
  if (stepText) ({ text: speech, cue } = withoutStepRecital(speech, stepText));
  let voicePrompt: VoicePrompt | null = null;
  let question: string | null = null;
  if (proposal) {
    cards.push({ type: 'proposal', ...pick(proposal, ['proposal_id', 'version', 'kind', 'card', 'expires_at']) });
    question = (proposal.card as { readback_text: string }).readback_text;
    // An adjustment to an item the meal uses: the read-back says what it leaves the meal.
    const impact = Array.isArray(proposal.impact_on_active_session) ? (proposal.impact_on_active_session as Array<{ item: string }>) : [];
    if (impact.length > 0) speech = withoutImpactTalk(speech, (s) => impact.some((i) => mentions(s, i.item)));
    // The model may repeat or paraphrase the read-back from the tool result; it is said once, last (§8.5).
    speech = withoutRecital(speech, question);
    voicePrompt = { kind: 'proposal_confirm', proposal_id: proposal.proposal_id as string, version: proposal.version as number };
  }
  // A card read-back takes precedence over a timer offer in the same message (§8.2).
  if (!voicePrompt && offer?.kind === 'timer_offer' && !(await stepHasTimer(pool, conversationId, offer.session_id, offer.step_no))) {
    // The offer is the one question the user answers (eval G5: "What would you like to do next?" before it).
    speech = withoutQuestions(speech);
    question = timerOffer(offer.seconds);
    voicePrompt = offer;
  }
  speech = [speech, stepSpeech, question ?? cue].filter(Boolean).join(' ');
  // The model said nothing and the app had nothing to add: never deliver a silent message.
  if (speech === '') speech = trigger.type === 'user' ? TURN_FAILED : trigger.events.map(fallbackSpeech).join(' ');

  const trace: TraceEntry[] = calls.map((c) => ({ name: c.name, input: c.final_input, isError: c.result!.isError, output: c.result!.data }));
  const messageId = await lease.write(async (tx) => {
    if (voicePrompt) await closeOpenWindows(tx, conversationId);
    const id = await insertOutbound(tx, {
      conversationId,
      turnType: trigger.type,
      speech,
      cards,
      voicePrompt,
      step,
    });
    if (trigger.type === 'user') {
      // The trace is stored with the response, so a replayed request returns the same body.
      await completeRequest(tx, conversationId, trigger.chatRequestId, { status: 200, body: { message_ids: [id], trace } });
    } else {
      await tx.query(`UPDATE agent.app_events SET turn_done_at = now() WHERE id = ANY ($1::uuid[])`, ['eventIds' in owner ? owner.eventIds : []]);
    }
    return id;
  });

  return { messageId, speech, trace };
}

/** Words that say which undo: "the whole meal", "just the correction", "everything". */
export const UNDO_SCOPE_SAID = /\b(?:whole|entire|meal|everything|correction|fix|just|only)\b/i;

/** Words that name a share of an item: "half the milk", "a third", "all the eggs". */
export const SHARE_SAID = /\b(?:half|halves|thirds?|quarters?|fourths?|all|whole|entire|everything|rest)\b/i;

/**
 * What the user said in their last `turns` turns: a share may be said a turn before the card
 * ("I spilled half the milk", "Which half?", "of the recipe").
 */
export function lastUserWords(messages: readonly Message[], turns: number): string {
  return messages
    .filter((m) => m.role === 'user')
    .map((m) =>
      m.content
        .filter(isText)
        .map((b) => b.text)
        .filter((t) => !t.startsWith('[app'))
        .join(' '),
    )
    .filter((t) => t !== '')
    .slice(-turns)
    .join(' ');
}

/** How many steps the user asked for: one per "next" said ("next, next"), at least one. */
export function nextsSaid(text: string): number {
  return Math.max(1, text.match(/\bnext\b/gi)?.length ?? 0);
}

/** Steps this turn's other next_step calls moved on. */
async function stepsTaken(pool: Pool, conversationId: string, owner: TurnOwner, toolUseId: string): Promise<number> {
  const calls = await callsOfTurn(pool, conversationId, owner);
  return calls.filter((c) => c.tool_use_id !== toolUseId && c.name === 'next_step' && c.result !== null && !c.result.isError).length;
}

/** Whether this turn delivered a step still to cook, through start_cooking or next_step. */
async function stepDelivered(pool: Pool, conversationId: string, owner: TurnOwner): Promise<boolean> {
  const calls = await callsOfTurn(pool, conversationId, owner);
  return calls.some(
    (c) => (c.name === 'start_cooking' || c.name === 'next_step') && c.result !== null && !c.result.isError && c.result.data.done !== true,
  );
}

/** Whether `text` names `item`, as a word, singular or plural ("the onions" names "onion"). */
export function mentions(text: string, item: string): boolean {
  const singular = item.trim().toLowerCase().replace(/(?:es|s)$/, '');
  const escaped = singular.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}(?:e?s)?\\b`, 'i').test(text);
}

/** Whether this turn's input told the model of a commit: only then may it say the stock changed. */
function heardCommit(messages: readonly Message[]): boolean {
  const input = messages.findLast((m) => m.role === 'user' && m.content.some(isText));
  return input?.content.some((b) => isText(b) && /^\[app event\] proposal \S+ v\d+ \(\w+\) committed\./.test(b.text)) ?? false;
}

/** Whether another call of this turn already made a card. */
async function cardOfTurn(pool: Pool, conversationId: string, owner: TurnOwner, toolUseId: string): Promise<boolean> {
  const calls = await callsOfTurn(pool, conversationId, owner);
  return calls.some((c) => c.tool_use_id !== toolUseId && c.name.startsWith('propose_') && c.result !== null && !c.result.isError);
}

const pick = (data: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]));

const toolError = (code: string, message: string): ToolOutput => ({ isError: true, data: { code, message }, text: message });

/** The request's messages with the empty-reply nudge added to the last (user) message; not persisted. */
function withNudge(messages: readonly Message[]): Message[] {
  const last = messages.at(-1)!;
  return [...messages.slice(0, -1), { role: last.role, content: [...last.content, { text: EMPTY_REPLY_NUDGE }] }];
}

/**
 * The persisted messages as Converse accepts them: consecutive messages of one role merged (a turn
 * that hit its cap ends on tool results, and the next turn starts with a user message), and no
 * empty text blocks.
 */
export function toModelMessages(messages: readonly Message[]): Message[] {
  const merged: Message[] = [];
  for (const m of messages) {
    const content = m.content.filter((b) => !isText(b) || b.text.trim() !== '');
    const prev = merged.at(-1);
    if (prev?.role === m.role) prev.content.push(...content);
    else merged.push({ role: m.role, content: [...content] });
  }
  for (const m of merged) {
    if (m.content.length === 0) m.content.push({ text: m.role === 'assistant' ? NO_REPLY : '(no input)' });
    // Tool results first: Converse wants them right after the toolUse they answer.
    m.content.sort((a, b) => Number(isToolResult(b)) - Number(isToolResult(a)));
  }
  return merged;
}
