// Background loops (IMPLEMENTATION_PLAN §8.6): the timer scheduler and the event worker that runs proactive turns.
import type { Pool } from './db.ts';
import type { AppEvent } from './store/events.ts';
import { ConversationLease, type LeaseTiming, withLease } from './store/lease.ts';
import { insertOutbound } from './store/outbound.ts';
import { fireDueTimers } from './store/timers.ts';
import { runTurn, type TurnDeps } from './turn/runTurn.ts';
import { fallbackSpeech } from './turn/speech.ts';

export interface WorkerTiming {
  schedulerMs: number;
  workerMs: number;
  /** How long a claimed event stays claimed before another worker may retry it. */
  claimMs: number;
  /** §8.1: at most one proactive turn per conversation per this interval. */
  proactiveGapMs: number;
  maxAttempts: number;
}

export const DEFAULT_WORKER_TIMING: WorkerTiming = {
  schedulerMs: 500,
  workerMs: 250,
  claimMs: 60_000,
  proactiveGapMs: 10_000,
  maxAttempts: 5,
};

type ClaimedEvent = AppEvent & { delivered: boolean; turn_attempts: number };

/**
 * §8.6 event worker claim: events that need a proactive turn, not done, not claimed (or the claim
 * ran out), under the attempt cap, in this household's conversations without a proactive message
 * in the last gap. Another household's events are not this agent's: its MCP token is not theirs.
 */
export async function claimEvents(
  pool: Pool,
  householdId: string,
  timing: WorkerTiming,
  skipConversations: readonly string[],
): Promise<ClaimedEvent[]> {
  const { rows } = await pool.query<ClaimedEvent>(
    `UPDATE agent.app_events
        SET turn_claimed_until = now() + make_interval(secs => $1::float / 1000), turn_attempts = turn_attempts + 1
      WHERE id IN (
            SELECT e.id FROM agent.app_events e
              JOIN agent.conversations c ON c.id = e.conversation_id AND c.household_id = $5
             WHERE e.triggers_turn AND e.turn_done_at IS NULL AND NOT e.turn_failed
               AND (e.turn_claimed_until IS NULL OR e.turn_claimed_until < now())
               AND e.turn_attempts < $3
               AND e.conversation_id <> ALL ($4::uuid[])
               AND NOT EXISTS (
                     SELECT 1 FROM agent.outbound_messages m
                      WHERE m.conversation_id = e.conversation_id AND m.turn_type = 'proactive'
                        AND m.created_at > now() - make_interval(secs => $2::float / 1000))
             ORDER BY e.created_at FOR UPDATE OF e SKIP LOCKED LIMIT 10)
      RETURNING id, conversation_id, kind, payload, created_at, delivered_at IS NOT NULL AS delivered, turn_attempts`,
    [timing.claimMs, timing.proactiveGapMs, timing.maxAttempts, skipConversations, householdId],
  );
  return rows.sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id));
}

export class Workers {
  private readonly pool: Pool;
  private readonly householdId: string;
  private readonly deps: TurnDeps;
  private readonly timing: WorkerTiming;
  private readonly leaseTiming: LeaseTiming | undefined;
  private readonly onError: (err: unknown, context: string) => void;
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly inFlight = new Map<string, Promise<void>>();
  private schedulerBusy = false;
  private workerBusy = false;

  constructor(
    deps: TurnDeps,
    householdId: string,
    options: { timing?: Partial<WorkerTiming>; leaseTiming?: LeaseTiming; onError?: (err: unknown, context: string) => void } = {},
  ) {
    this.pool = deps.pool;
    this.householdId = householdId;
    this.deps = deps;
    this.timing = { ...DEFAULT_WORKER_TIMING, ...options.timing };
    this.leaseTiming = options.leaseTiming;
    this.onError = options.onError ?? (() => {});
  }

  start(): void {
    this.timers.push(setInterval(() => void this.tickScheduler(), this.timing.schedulerMs));
    this.timers.push(setInterval(() => void this.tickEvents(), this.timing.workerMs));
    for (const t of this.timers) t.unref();
  }

  /** Stops the loops and waits for proactive turns already running. */
  async stop(): Promise<void> {
    for (const t of this.timers.splice(0)) clearInterval(t);
    await Promise.allSettled(this.inFlight.values());
  }

  /** One scheduler pass: fire due timers into durable events (outbox). */
  async tickScheduler(): Promise<void> {
    if (this.schedulerBusy) return;
    this.schedulerBusy = true;
    try {
      await fireDueTimers(this.pool, this.householdId);
    } catch (err) {
      this.onError(err, 'scheduler');
    } finally {
      this.schedulerBusy = false;
    }
  }

  /** One worker pass: claim events and start one proactive turn per conversation, coalescing its events. */
  async tickEvents(): Promise<void> {
    if (this.workerBusy) return;
    this.workerBusy = true;
    try {
      const claimed = await claimEvents(this.pool, this.householdId, this.timing, [...this.inFlight.keys()]);
      const byConversation = new Map<string, ClaimedEvent[]>();
      for (const e of claimed) byConversation.set(e.conversation_id, [...(byConversation.get(e.conversation_id) ?? []), e]);
      for (const [conversationId, events] of byConversation) {
        const run = this.proactiveTurn(conversationId, events).finally(() => this.inFlight.delete(conversationId));
        this.inFlight.set(conversationId, run);
      }
    } catch (err) {
      this.onError(err, 'event worker');
    } finally {
      this.workerBusy = false;
    }
  }

  /** Waits for every proactive turn started so far (tests). */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight.values()]);
  }

  private async proactiveTurn(conversationId: string, events: ClaimedEvent[]): Promise<void> {
    try {
      await withLease(this.pool, conversationId, (lease) => runTurn(this.deps, lease, { type: 'proactive', events }), this.leaseTiming);
    } catch (err) {
      this.onError(err, `proactive turn for ${conversationId}`);
      // The claim runs out and a later pass retries; after the last attempt, say something templated.
      if (events.some((e) => e.turn_attempts >= this.timing.maxAttempts)) await this.giveUp(conversationId, events);
    }
  }

  private async giveUp(conversationId: string, events: ClaimedEvent[]): Promise<void> {
    try {
      await withLease(
        this.pool,
        conversationId,
        (lease: ConversationLease) =>
          lease.write(async (tx) => {
            await tx.query(`UPDATE agent.app_events SET turn_failed = true WHERE id = ANY ($1::uuid[])`, [events.map((e) => e.id)]);
            await insertOutbound(tx, { conversationId, turnType: 'proactive', speech: events.map(fallbackSpeech).join(' ') });
          }),
        this.leaseTiming,
      );
    } catch (err) {
      this.onError(err, `fallback for ${conversationId}`);
    }
  }
}
