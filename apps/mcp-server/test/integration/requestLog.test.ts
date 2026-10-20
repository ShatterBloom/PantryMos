// Request idempotency (§5.1) against real Postgres, including concurrent duplicates,
// and the write-tool wrapper built on it.
import { randomUUID } from 'node:crypto';
import { META_CONVERSATION_ID, META_REQUEST_ID } from '@pantrymos/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, type Pool } from '../../src/db/pool.ts';
import { type Outcome, runIdempotent } from '../../src/db/requestLog.ts';
import type { Tx } from '../../src/db/tx.ts';
import { PantryError } from '../../src/domain/errors.ts';
import type { ToolContext } from '../../src/mcp/context.ts';
import { runWriteTool } from '../../src/mcp/toolkit.ts';
import { createHousehold, mcpTestConfig } from '../../../../test/fixtures.ts';
import { TEST_MCP_DB_URL } from '../../../../test/env.ts';

describe('runIdempotent', () => {
  let pool: Pool;
  let householdId: string;
  let otherHouseholdId: string;

  beforeAll(async () => {
    pool = createPool(TEST_MCP_DB_URL);
    householdId = (await createHousehold()).householdId;
    otherHouseholdId = (await createHousehold()).householdId;
  });
  afterAll(async () => pool.end());

  /** Observable side effect: inserts a household tagged with `marker`. */
  const insertMarker = (marker: string, delaySeconds = 0) => async (tx: Tx): Promise<Outcome> => {
    if (delaySeconds > 0) await tx.query('SELECT pg_sleep($1)', [delaySeconds]);
    const id = randomUUID();
    await tx.query(`INSERT INTO pantry.households (id, name) VALUES ($1, $2)`, [id, marker]);
    return { status: 200, body: { id } };
  };
  const countMarker = async (marker: string) =>
    Number((await pool.query(`SELECT count(*) FROM pantry.households WHERE name = $1`, [marker])).rows[0].count);
  const key = (overrides: Partial<Parameters<typeof runIdempotent>[1]> = {}) => ({
    householdId,
    requestId: randomUUID(),
    scope: 'test:insert',
    payload: { n: 1 },
    ...overrides,
  });

  it('runs the effect once and replays the identical stored outcome (R9/R10 mechanism)', async () => {
    const marker = randomUUID();
    const k = key();
    const first = await runIdempotent(pool, k, insertMarker(marker));
    const second = await runIdempotent(pool, k, insertMarker(marker));
    expect(first.replayed).toBe(false);
    expect(second).toEqual({ ...first, replayed: true });
    expect(await countMarker(marker)).toBe(1);
  });

  it('treats payloads that differ only in key order as the same request', async () => {
    const marker = randomUUID();
    const k = key({ payload: { a: 1, b: { c: 2, d: 3 } } });
    await runIdempotent(pool, k, insertMarker(marker));
    const again = await runIdempotent(pool, { ...k, payload: { b: { d: 3, c: 2 }, a: 1 } }, insertMarker(marker));
    expect(again.replayed).toBe(true);
    expect(await countMarker(marker)).toBe(1);
  });

  it('rejects a reused request_id with different input or scope, without running the effect (R11)', async () => {
    const marker = randomUUID();
    const k = key();
    const original = await runIdempotent(pool, k, insertMarker(marker));

    const otherPayload = await runIdempotent(pool, { ...k, payload: { n: 2 } }, insertMarker(marker));
    const otherScope = await runIdempotent(pool, { ...k, scope: 'test:other' }, insertMarker(marker));
    for (const res of [otherPayload, otherScope]) {
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'request_conflict' });
    }
    expect(await countMarker(marker)).toBe(1);
    // The original stays replayable.
    expect(await runIdempotent(pool, k, insertMarker(marker))).toEqual({ ...original, replayed: true });
  });

  it('stores a business error as the durable result and discards the effect writes', async () => {
    const marker = randomUUID();
    const k = key();
    const failing = async (tx: Tx): Promise<Outcome> => {
      await insertMarker(marker)(tx);
      throw new PantryError('insufficient_stock', 'Not enough eggs.', { need: 3, have: 2 });
    };
    const first = await runIdempotent(pool, k, failing);
    expect(first).toEqual({
      status: 409,
      body: { code: 'insufficient_stock', message: 'Not enough eggs.', need: 3, have: 2 },
      replayed: false,
    });
    expect(await countMarker(marker)).toBe(0);
    // A retry replays the error; it does not re-run the effect, even one that would now succeed.
    expect(await runIdempotent(pool, k, insertMarker(marker))).toEqual({ ...first, replayed: true });
    expect(await countMarker(marker)).toBe(0);
  });

  it('keeps writes of a returned non-200 outcome (durable business failure)', async () => {
    const marker = randomUUID();
    const res = await runIdempotent(pool, key(), async (tx) => {
      await insertMarker(marker)(tx);
      return { status: 409, body: { code: 'stale_state' } };
    });
    expect(res.status).toBe(409);
    expect(await countMarker(marker)).toBe(1);
  });

  it('rolls back the log row on a fault, so a retry runs the effect', async () => {
    const marker = randomUUID();
    const k = key();
    await expect(
      runIdempotent(pool, k, async (tx) => {
        await insertMarker(marker)(tx);
        throw new Error('connection reset');
      }),
    ).rejects.toThrow('connection reset');
    expect(await countMarker(marker)).toBe(0);

    const retry = await runIdempotent(pool, k, insertMarker(marker));
    expect(retry.replayed).toBe(false);
    expect(await countMarker(marker)).toBe(1);
  });

  it('serializes concurrent duplicates: one effect, identical responses', async () => {
    const marker = randomUUID();
    const k = key();
    const results = await Promise.all([
      runIdempotent(pool, k, insertMarker(marker, 0.3)),
      runIdempotent(pool, k, insertMarker(marker, 0.3)),
      runIdempotent(pool, k, insertMarker(marker, 0.3)),
    ]);
    expect(await countMarker(marker)).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    const bodies = new Set(results.map((r) => JSON.stringify(r.body)));
    expect(bodies.size).toBe(1);
  });

  it('scopes request ids per household', async () => {
    const marker = randomUUID();
    const requestId = randomUUID();
    await runIdempotent(pool, key({ requestId }), insertMarker(marker));
    const other = await runIdempotent(pool, key({ requestId, householdId: otherHouseholdId }), insertMarker(marker));
    expect(other.replayed).toBe(false);
    expect(await countMarker(marker)).toBe(2);
  });
});

describe('runWriteTool', () => {
  let pool: Pool;
  let ctx: ToolContext;

  beforeAll(async () => {
    pool = createPool(TEST_MCP_DB_URL);
    const { householdId } = await createHousehold();
    ctx = { pool, auth: { clientId: randomUUID(), householdId }, config: mcpTestConfig() };
  });
  afterAll(async () => pool.end());

  const call = (meta: Record<string, unknown> | undefined, args: unknown = { x: 1 }) => ({
    name: 'test_tool',
    args,
    meta,
    needsConversation: true,
  });
  const meta = () => ({ [META_REQUEST_ID]: randomUUID(), [META_CONVERSATION_ID]: randomUUID() });

  it('runs once per request_id and replays the same result', async () => {
    let runs = 0;
    const effect = async () => {
      runs += 1;
      return { data: { runs }, text: 'ok' };
    };
    const m = meta();
    const first = await runWriteTool(ctx, call(m), effect);
    const second = await runWriteTool(ctx, call(m), effect);
    expect(first).toEqual({ content: [{ type: 'text', text: 'ok' }], structuredContent: { runs: 1 } });
    expect(second).toEqual(first);
    expect(runs).toBe(1);
  });

  it('passes the resolved ids to the effect', async () => {
    const m = meta();
    const res = await runWriteTool(ctx, call(m), async (_tx, resolved) => ({ data: { ...resolved }, text: 'ok' }));
    expect(res.structuredContent).toEqual({
      requestId: m[META_REQUEST_ID],
      conversationId: m[META_CONVERSATION_ID],
    });
  });

  it('returns isError results for missing metadata, conflicts and business errors', async () => {
    const noMeta = await runWriteTool(ctx, call(undefined), async () => ({ data: {}, text: 'ok' }));
    expect(noMeta).toMatchObject({ isError: true, structuredContent: { code: 'request_id_required' } });

    const m = meta();
    await runWriteTool(ctx, call(m), async () => ({ data: {}, text: 'ok' }));
    const conflict = await runWriteTool(ctx, call(m, { x: 2 }), async () => ({ data: {}, text: 'ok' }));
    expect(conflict).toMatchObject({ isError: true, structuredContent: { code: 'request_conflict' } });

    const business = await runWriteTool(ctx, call(meta()), async () => {
      throw new PantryError('unknown_item', 'No such item.', { ask: 'What kind of item is it?' });
    });
    expect(business).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'No such item. What kind of item is it?' }],
      structuredContent: { code: 'unknown_item', message: 'No such item.', ask: 'What kind of item is it?' },
    });
  });

  it('rethrows faults so the transaction rolls back', async () => {
    await expect(
      runWriteTool(ctx, call(meta()), async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});
