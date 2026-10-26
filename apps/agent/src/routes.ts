// User-action routes (IMPLEMENTATION_PLAN §8.8): chat, voice-window acks, card actions, message polling and the web view.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AgentConfig } from './config.ts';
import type { Pool } from './db.ts';
import { runGate } from './gate/confirmGate.ts';
import type { InternalClient, InternalResponse, ProposalView } from './internalClient.ts';
import { ModelUnavailableError } from './model/types.ts';
import { appConversations, conversationExists, ensureConversation } from './store/conversations.ts';
import { insertEvent } from './store/events.ts';
import { LeaseBusyError, type LeaseTiming, withLease } from './store/lease.ts';
import { insertOutbound, listOutbound, outboundById } from './store/outbound.ts';
import { abandonRequest, claimRequest, completeRequest, finishedResponse, type RequestKey } from './store/requestLog.ts';
import { activeTimers } from './store/timers.ts';
import { closeOpenWindows, openWindow, WINDOW_MS } from './store/windows.ts';
import { runTurn, type TurnDeps } from './turn/runTurn.ts';
import { fallbackSpeech } from './turn/speech.ts';

export interface RouteDeps {
  pool: Pool;
  config: AgentConfig;
  internal: InternalClient;
  turn: TurnDeps;
  leaseTiming?: LeaseTiming;
  windowMs?: number;
}

const ChatBody = z.object({
  conversation_id: z.uuid(),
  request_id: z.uuid(),
  text: z.string().trim().min(1).max(500),
  input_mode: z.enum(['voice', 'text']),
});
const AckBody = z.object({ conversation_id: z.uuid(), message_id: z.number().int().positive(), request_id: z.uuid() });
const MessagesQuery = z.object({ conversation_id: z.uuid(), after: z.coerce.number().int().min(0).default(0) });
const ConversationQuery = z.object({ conversation_id: z.uuid() });
const LedgerQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });
const ProposalParams = z.object({ id: z.uuid() });
/** The chat the app has open: where a card another MCP client made is answered. */
const OpenChat = { conversation_id: z.uuid().optional() };
const CardBody = z.object({ version: z.number().int().min(1), request_id: z.uuid(), ...OpenChat });
const EditBody = z.object({ base_version: z.number().int().min(1), changes: z.unknown(), request_id: z.uuid(), ...OpenChat });
const RegenerateBody = z.object({ request_id: z.uuid(), ...OpenChat });

const badRequest = (reply: FastifyReply, issues: unknown) => reply.code(400).send({ error: 'bad_request', issues });

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { pool, config, internal } = deps;

  app.post(
    '/api/chat',
    { config: { rateLimit: { max: config.chatRatePerMinute, timeWindow: '1 minute', keyGenerator: () => `chat:${config.userId}` } } },
    async (request, reply) => {
      const parsed = ChatBody.safeParse(request.body);
      if (!parsed.success) return badRequest(reply, parsed.error.issues);
      const body = parsed.data;
      if (!(await ensureConversation(pool, body.conversation_id, config.householdId, config.userId))) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return idempotent(
        reply,
        { conversationId: body.conversation_id, requestId: body.request_id, route: 'api:chat', payload: { text: body.text, input_mode: body.input_mode } },
        async (claim) =>
          withLease(
            pool,
            body.conversation_id,
            async (lease) => {
              // A slow first attempt may have finished while this retry waited for the lease.
              const finished = await finishedResponse(pool, body.conversation_id, body.request_id);
              if (finished) return finished as InternalResponse;
              if (body.input_mode === 'voice') {
                // §8.5: the gate runs before any model call.
                const gate = await runGate({ pool, internal, userId: config.userId }, lease, body.request_id, body.text);
                if (gate) return { status: 200, body: { message_ids: [gate.messageId] } };
              }
              const result = await runTurn(deps.turn, lease, {
                type: 'user',
                chatRequestId: body.request_id,
                text: body.text,
                resume: claim.kind === 'resume' ? { started: claim.started, snapshot: claim.snapshot } : null,
              });
              return { status: 200, body: { message_ids: [result.messageId], trace: result.trace } };
            },
            deps.leaseTiming,
          ),
      );
    },
  );

  app.post('/api/voice-windows/ack', async (request, reply) => {
    const parsed = AckBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);
    const { conversation_id, message_id } = parsed.data;
    if (!(await conversationExists(pool, conversation_id, config.householdId))) return reply.code(404).send({ error: 'not_found' });
    const result = await withLease(
      pool,
      conversation_id,
      (lease) =>
        lease.write(async (tx) => {
          const message = await outboundById(tx, conversation_id, message_id);
          if (!message?.voice_prompt) return null;
          // Only the latest question can be answered: a newer prompt already closed this one (§8.5).
          const newer = await tx.query(
            `SELECT 1 FROM agent.outbound_messages WHERE conversation_id = $1 AND id > $2 AND voice_prompt IS NOT NULL LIMIT 1`,
            [conversation_id, message_id],
          );
          if (newer.rowCount !== 0) return 'superseded' as const;
          return openWindow(tx, message, deps.windowMs ?? WINDOW_MS);
        }),
      deps.leaseTiming,
    );
    if (result === null) return reply.code(404).send({ error: 'not_found' });
    if (result === 'superseded') return reply.code(409).send({ error: 'superseded' });
    return reply.send({ window_id: result.id, window_ends_at: result.window_ends_at.toISOString() });
  });

  app.get('/api/messages', async (request, reply) => {
    const parsed = MessagesQuery.safeParse(request.query);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);
    const { conversation_id, after } = parsed.data;
    if (!(await conversationExists(pool, conversation_id, config.householdId))) return reply.code(404).send({ error: 'not_found' });
    const messages = await listOutbound(pool, conversation_id, after);
    return reply.send({ messages: messages.map((m) => ({ ...m, created_at: m.created_at.toISOString() })) });
  });

  // The web view (§8.8): stock, the ledger, running timers and a card's current state.
  app.get('/api/inventory', async (_request, reply) => {
    const res = await internal.inventory(config.householdId);
    return reply.code(res.status).send(res.body);
  });

  app.get('/api/ledger', async (request, reply) => {
    const parsed = LedgerQuery.safeParse(request.query);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);
    const res = await internal.ledger(config.householdId, parsed.data.limit);
    return reply.code(res.status).send(res.body);
  });

  app.get('/api/timers', async (request, reply) => {
    const parsed = ConversationQuery.safeParse(request.query);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);
    if (!(await conversationExists(pool, parsed.data.conversation_id, config.householdId))) return reply.code(404).send({ error: 'not_found' });
    return reply.send({ timers: await activeTimers(pool, parsed.data.conversation_id) });
  });

  app.get('/api/proposals/:id', async (request, reply) => {
    const params = ProposalParams.safeParse(request.params);
    if (!params.success) return badRequest(reply, params.error.issues);
    const view = await internal.view(params.data.id);
    if (!view || view.household_id !== config.householdId) return reply.code(404).send({ error: 'not_found' });
    return reply.send(view);
  });

  /** Pending cards other MCP clients made: the app is where the user confirms them. */
  app.get('/api/inbox', async (_request, reply) => {
    const res = await internal.pending(config.householdId);
    if (res.status !== 200) return reply.code(res.status).send(res.body);
    const pending = res.body.proposals as Array<ProposalView & { client: string | null }>;
    const fromApp = await appConversations(pool, [...new Set(pending.map((p) => p.conversation_id))], config.householdId);
    return reply.send({
      proposals: pending.filter((p) => !fromApp.has(p.conversation_id)).map(({ household_id: _h, conversation_id: _c, ...card }) => card),
    });
  });

  /**
   * Card actions act on this household's proposals only. A card made in one of the app's
   * conversations is answered there. One another MCP client made is answered in the chat the app
   * has open, with a fixed line rather than a model turn: that chat's model never saw the card.
   */
  const cardAction =
    <B extends z.ZodType>(Body: B, route: string, act: (view: ProposalView, body: z.infer<B>) => Promise<CardResult>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = ProposalParams.safeParse(request.params);
      const parsed = Body.safeParse(request.body);
      if (!params.success || !parsed.success) return badRequest(reply, [...(params.error?.issues ?? []), ...(parsed.error?.issues ?? [])]);
      const view = await internal.view(params.data.id);
      if (!view || view.household_id !== config.householdId) return reply.code(404).send({ error: 'not_found' });
      const body = parsed.data as z.infer<B> & { request_id: string; conversation_id?: string };
      const fromApp = await conversationExists(pool, view.conversation_id, config.householdId);
      const conversationId = fromApp ? view.conversation_id : body.conversation_id;
      if (!conversationId || (!fromApp && !(await ensureConversation(pool, conversationId, config.householdId, config.userId)))) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return idempotent(reply, { conversationId, requestId: body.request_id, route, payload: { proposal_id: view.proposal_id, ...body } }, () =>
        withLease(pool, conversationId, async (lease) => {
          const finished = await finishedResponse(pool, conversationId, body.request_id);
          if (finished) return finished as InternalResponse;
          const result = await act(view, body);
          await lease.write(async (tx) => {
            for (const e of result.events ?? []) {
              await insertEvent(tx, { conversationId, ...e, triggersTurn: fromApp && e.triggersTurn });
              if (!fromApp && e.kind !== 'proposal_rejected') {
                await insertOutbound(tx, { conversationId, turnType: 'gate', speech: fallbackSpeech({ kind: e.kind, payload: e.payload }) });
              }
            }
            // The user answered by button: an open voice question no longer stands (§8.5).
            await closeOpenWindows(tx, conversationId);
            if (result.readBack) {
              // An edited or refreshed card is read back again (§8.8).
              const fresh = result.readBack;
              await insertOutbound(tx, {
                conversationId,
                turnType: 'gate',
                speech: fresh.card.readback_text,
                cards: [{ type: 'proposal', proposal_id: fresh.proposal_id, version: fresh.version, kind: fresh.kind, card: fresh.card, expires_at: fresh.expires_at }],
                voicePrompt: { kind: 'proposal_confirm', proposal_id: fresh.proposal_id, version: fresh.version },
              });
            }
            await completeRequest(tx, conversationId, body.request_id, result.response);
          });
          return result.response;
        }, deps.leaseTiming),
      );
    };

  const outcomeEvent = (view: ProposalView, version: number, res: InternalResponse) => {
    const base = { payload: { proposal_id: view.proposal_id, version, kind: view.kind } };
    if (res.status === 200) {
      return {
        kind: 'proposal_committed' as const,
        payload: { ...base.payload, summary: res.body.summary },
        dedupeKey: `proposal:${view.proposal_id}:v${version}:committed`,
        triggersTurn: true,
      };
    }
    if (res.body.code === 'stale_state') {
      return {
        kind: 'proposal_stale' as const,
        payload: { ...base.payload, reason: res.body.reason },
        dedupeKey: `proposal:${view.proposal_id}:v${version}:stale`,
        triggersTurn: true,
      };
    }
    return null;
  };

  app.post(
    '/api/proposals/:id/confirm',
    cardAction(CardBody, 'api:confirm', async (view, body) => {
      const res = await internal.confirm(view.proposal_id, { version: body.version, user_id: config.userId, channel: 'ui_click', request_id: body.request_id });
      const event = outcomeEvent(view, body.version, res);
      return { response: res, events: event ? [event] : [] };
    }),
  );

  app.post(
    '/api/proposals/:id/reject',
    cardAction(CardBody, 'api:reject', async (view, body) => {
      const res = await internal.reject(view.proposal_id, body);
      const events =
        res.status === 200
          ? [
              {
                kind: 'proposal_rejected' as const,
                payload: { proposal_id: view.proposal_id, version: body.version, kind: view.kind },
                dedupeKey: `proposal:${view.proposal_id}:v${body.version}:rejected`,
                triggersTurn: false,
              },
            ]
          : [];
      return { response: res, events };
    }),
  );

  app.patch(
    '/api/proposals/:id',
    cardAction(EditBody, 'api:edit', async (view, body) => {
      const res = await internal.edit(view.proposal_id, body);
      // An edit can land on another card that replaces this one: read back the card it made.
      return { response: res, readBack: res.status === 200 ? await internal.view(res.body.proposal_id as string) : null };
    }),
  );

  app.post(
    '/api/proposals/:id/regenerate',
    cardAction(RegenerateBody, 'api:regenerate', async (view, body) => {
      const res = await internal.regenerate(view.proposal_id, body);
      return { response: res, readBack: res.status === 200 ? await internal.view(res.body.proposal_id as string) : null };
    }),
  );

  /**
   * §5.2 around a route: replays a finished request, refuses a reused id with other input or one
   * still running, and otherwise runs `fn`. A fault drops the claim's lease so a retry resumes.
   */
  async function idempotent(
    reply: FastifyReply,
    key: RequestKey,
    fn: (claim: Extract<Awaited<ReturnType<typeof claimRequest>>, { kind: 'new' | 'resume' }>) => Promise<InternalResponse>,
  ) {
    const claim = await claimRequest(pool, key);
    switch (claim.kind) {
      case 'done':
        return reply.code(claim.status).send(claim.response);
      case 'conflict':
        return reply.code(409).send({ code: 'request_conflict', message: 'This request_id was already used for a different request.' });
      case 'in_progress':
        return reply
          .code(409)
          .header('retry-after', String(claim.retryAfterSeconds))
          .send({ code: 'request_in_progress', message: 'This request is still running.', retry_after: claim.retryAfterSeconds });
    }
    try {
      const result = await fn(claim);
      return reply.code(result.status).send(result.body);
    } catch (err) {
      await abandonRequest(pool, key.conversationId, key.requestId).catch(() => {});
      if (err instanceof LeaseBusyError) {
        return reply.code(503).header('retry-after', '1').send({ code: 'busy', message: 'Mos is still answering. Try again in a moment.' });
      }
      // Not a fault: the app says what to do (sign in again, or manage the plan's usage).
      if (err instanceof ModelUnavailableError) {
        return reply.code(503).send({ code: 'model_unavailable', reason: err.reason, message: err.message });
      }
      throw err;
    }
  }
}

interface CardResult {
  response: InternalResponse;
  events?: Array<{ kind: 'proposal_committed' | 'proposal_stale' | 'proposal_rejected'; payload: Record<string, unknown>; dedupeKey: string; triggersTurn: boolean }>;
  readBack?: ProposalView | null;
}
