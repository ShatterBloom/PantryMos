// The conversation lock (§8.1): a lease, renewed while held, fenced on every write.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '../../src/db.ts';
import { ConversationLease, LeaseBusyError, LeaseLostError, withLease } from '../../src/store/lease.ts';
import { TEST_AGENT_DB_URL } from '../../../../test/env.ts';

const FAST = { leaseMs: 300, renewMs: 100, waitMs: 1500 };

describe('ConversationLease', () => {
  let pool: pg.Pool;
  beforeAll(() => {
    pool = createPool(TEST_AGENT_DB_URL);
  });
  afterAll(async () => pool.end());

  let conversationId: string;
  beforeEach(async () => {
    conversationId = randomUUID();
    await pool.query(`INSERT INTO agent.conversations (id, household_id, user_id) VALUES ($1, $2, 'demo')`, [conversationId, randomUUID()]);
  });

  const holder = async () =>
    (await pool.query<{ holder: string }>(`SELECT holder FROM agent.conversation_locks WHERE conversation_id = $1`, [conversationId])).rows[0]
      ?.holder;

  it('serializes holders: the second waits until the first releases', async () => {
    const order: string[] = [];
    const first = await ConversationLease.acquire(pool, conversationId, FAST);
    const second = withLease(pool, conversationId, async () => order.push('second'), FAST);
    await new Promise((resolve) => setTimeout(resolve, 150));
    order.push('first done');
    await first.release();
    await second;
    expect(order).toEqual(['first done', 'second']);
  });

  it('keeps a held lease alive past its length by renewing it', async () => {
    const lease = await ConversationLease.acquire(pool, conversationId, FAST);
    await new Promise((resolve) => setTimeout(resolve, 700));
    await expect(lease.write(async () => 'ok')).resolves.toBe('ok');
    await expect(ConversationLease.acquire(pool, conversationId, { ...FAST, waitMs: 200 })).rejects.toBeInstanceOf(LeaseBusyError);
    await lease.release();
  });

  it('lets another holder take an expired lease, and fences the old holder out', async () => {
    const stale = await ConversationLease.acquire(pool, conversationId, { ...FAST, renewMs: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 400)); // not renewed: it expires
    const fresh = await ConversationLease.acquire(pool, conversationId, FAST);
    expect(await holder()).toBe(fresh.holder);
    await expect(stale.write(async () => 'late write')).rejects.toBeInstanceOf(LeaseLostError);
    expect(await stale.renew()).toBe(false);
    await stale.release(); // does not free the new holder's lock
    expect(await holder()).toBe(fresh.holder);
    await expect(fresh.write(async () => 'ok')).resolves.toBe('ok');
    await fresh.release();
  });

  it('frees the lock however the work ends', async () => {
    await expect(withLease(pool, conversationId, async () => Promise.reject(new Error('boom')), FAST)).rejects.toThrow('boom');
    await expect(withLease(pool, conversationId, async () => 'next', FAST)).resolves.toBe('next');
  });
});
