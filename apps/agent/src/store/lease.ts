// The conversation lock (IMPLEMENTATION_PLAN §8.1): a lease row, so no transaction spans a Bedrock call.
import { randomUUID } from 'node:crypto';
import { type Pool, type Tx, withTransaction } from '../db.ts';

export interface LeaseTiming {
  /** How long an acquired or renewed lease lasts. */
  leaseMs: number;
  /** How often a held lease is renewed. */
  renewMs: number;
  /** How long `acquire` keeps retrying before giving up. */
  waitMs: number;
}

export const DEFAULT_LEASE_TIMING: LeaseTiming = { leaseMs: 30_000, renewMs: 10_000, waitMs: 60_000 };

/** Thrown when a write finds the lease held by someone else: this turn must stop writing. */
export class LeaseLostError extends Error {
  constructor(conversationId: string) {
    super(`Lost the lock on conversation ${conversationId}`);
    this.name = 'LeaseLostError';
  }
}

/** Thrown when the lock stays busy for longer than `waitMs`. */
export class LeaseBusyError extends Error {
  constructor(conversationId: string) {
    super(`Conversation ${conversationId} is busy`);
    this.name = 'LeaseBusyError';
  }
}

export class ConversationLease {
  private renewer: NodeJS.Timeout | null = null;
  private readonly pool: Pool;
  readonly conversationId: string;
  readonly holder: string;
  private readonly timing: LeaseTiming;

  private constructor(pool: Pool, conversationId: string, holder: string, timing: LeaseTiming) {
    this.pool = pool;
    this.conversationId = conversationId;
    this.holder = holder;
    this.timing = timing;
  }

  /**
   * Takes the lock if it is free or its lease expired, retrying with backoff (100 ms → 1 s), then
   * renews it in the background until released.
   */
  static async acquire(pool: Pool, conversationId: string, timing: LeaseTiming = DEFAULT_LEASE_TIMING): Promise<ConversationLease> {
    const holder = randomUUID();
    const deadline = Date.now() + timing.waitMs;
    for (let delay = 100; ; delay = Math.min(delay * 2, 1000)) {
      if (await tryAcquire(pool, conversationId, holder, timing.leaseMs)) {
        const lease = new ConversationLease(pool, conversationId, holder, timing);
        lease.renewer = setInterval(() => void lease.renew().catch(() => {}), timing.renewMs);
        lease.renewer.unref();
        return lease;
      }
      if (Date.now() + delay > deadline) throw new LeaseBusyError(conversationId);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  /** Extends the lease; false once someone else holds it. */
  async renew(): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE agent.conversation_locks SET lease_until = now() + make_interval(secs => $3::float / 1000)
        WHERE conversation_id = $1 AND holder = $2`,
      [this.conversationId, this.holder, this.timing.leaseMs],
    );
    return rowCount === 1;
  }

  /** Frees the lock now, only if this lease still holds it. */
  async release(): Promise<void> {
    if (this.renewer) clearInterval(this.renewer);
    this.renewer = null;
    await this.pool.query(`UPDATE agent.conversation_locks SET lease_until = now() WHERE conversation_id = $1 AND holder = $2`, [
      this.conversationId,
      this.holder,
    ]);
  }

  /**
   * Fencing (§8.1): runs `fn` in a transaction that first checks this lease still holds the lock,
   * and keeps a share lock on the lock row so no one can take it over until the transaction ends.
   */
  async write<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, async (tx) => {
      await this.fence(tx);
      return fn(tx);
    });
  }

  async fence(tx: Tx): Promise<void> {
    const { rowCount } = await tx.query(
      `SELECT 1 FROM agent.conversation_locks
        WHERE conversation_id = $1 AND holder = $2 AND lease_until > now()
          FOR SHARE`,
      [this.conversationId, this.holder],
    );
    if (rowCount !== 1) throw new LeaseLostError(this.conversationId);
  }
}

async function tryAcquire(pool: Pool, conversationId: string, holder: string, leaseMs: number): Promise<boolean> {
  const { rows } = await pool.query<{ holder: string }>(
    `INSERT INTO agent.conversation_locks (conversation_id, holder, lease_until)
     VALUES ($1, $2, now() + make_interval(secs => $3::float / 1000))
     ON CONFLICT (conversation_id) DO UPDATE SET holder = EXCLUDED.holder, lease_until = EXCLUDED.lease_until
      WHERE conversation_locks.lease_until < now()
     RETURNING holder`,
    [conversationId, holder, leaseMs],
  );
  return rows[0]?.holder === holder;
}

/** Runs `fn` under the conversation lock, releasing it however `fn` ends. */
export async function withLease<T>(
  pool: Pool,
  conversationId: string,
  fn: (lease: ConversationLease) => Promise<T>,
  timing?: LeaseTiming,
): Promise<T> {
  const lease = await ConversationLease.acquire(pool, conversationId, timing);
  try {
    return await fn(lease);
  } finally {
    await lease.release().catch(() => {});
  }
}
