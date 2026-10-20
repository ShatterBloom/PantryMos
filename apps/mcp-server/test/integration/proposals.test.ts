// Proposal upsert rule and version history (§4.1) against real Postgres.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, type Pool } from '../../src/db/pool.ts';
import { type ProposalDraft, upsertProposal } from '../../src/db/proposals.ts';
import { withTransaction } from '../../src/db/tx.ts';
import { createHousehold, withAdmin } from '../../../../test/fixtures.ts';
import { TEST_MCP_DB_URL } from '../../../../test/env.ts';

describe('upsertProposal', () => {
  let pool: Pool;
  let householdId: string;

  beforeAll(async () => {
    pool = createPool(TEST_MCP_DB_URL);
    householdId = (await createHousehold()).householdId;
  });
  afterAll(async () => pool.end());

  const draft = (subjectKey: string, payload: unknown = { lines: [{ item: 'egg', quantity: 12 }] }): ProposalDraft => ({
    kind: 'intake',
    subjectKey,
    conversationId: randomUUID(),
    input: { items: [{ name: 'egg', quantity: 12 }] },
    payload,
    preconditions: { catalog: { absent_items: [] } },
  });
  const upsert = (d: ProposalDraft) => withTransaction(pool, (tx) => upsertProposal(tx, householdId, d));
  const subject = () => `intake:conv:${randomUUID()}`;

  const history = async (proposalId: string) =>
    (
      await pool.query<{ version: number; payload: unknown }>(
        `SELECT version, payload FROM pantry.proposal_versions WHERE proposal_id = $1 ORDER BY version`,
        [proposalId],
      )
    ).rows;
  const current = async (proposalId: string) =>
    (
      await pool.query<{ version: number; payload: unknown; status: string }>(
        `SELECT version, payload, status FROM pantry.proposals WHERE id = $1`,
        [proposalId],
      )
    ).rows[0];

  it('creates version 1 with its history row, expiring in two hours', async () => {
    const before = Date.now();
    const ref = await upsert(draft(subject()));
    expect(ref).toMatchObject({ version: 1, outcome: 'created' });
    const ttl = new Date(ref.expires_at).getTime() - before;
    expect(ttl).toBeGreaterThan(2 * 3600_000 - 60_000);
    expect(ttl).toBeLessThan(2 * 3600_000 + 60_000);
    expect(await history(ref.proposal_id)).toEqual([{ version: 1, payload: { lines: [{ item: 'egg', quantity: 12 }] } }]);
  });

  it('returns the same version for an identical plan, regardless of key order (R23)', async () => {
    const key = subject();
    const first = await upsert(draft(key, { a: 1, b: { c: 2, d: 3 } }));
    const again = await upsert(draft(key, { b: { d: 3, c: 2 }, a: 1 }));
    expect(again).toEqual({ ...first, outcome: 'unchanged' });
    expect(await history(first.proposal_id)).toHaveLength(1);
  });

  it('appends a new version for a different plan and keeps every earlier version (R23, R29)', async () => {
    const key = subject();
    const v1 = await upsert(draft(key, { n: 1 }));
    const v2 = await upsert(draft(key, { n: 2 }));
    const v3 = await upsert(draft(key, { n: 3 }));
    expect([v2.proposal_id, v3.proposal_id]).toEqual([v1.proposal_id, v1.proposal_id]);
    expect([v2, v3].map((r) => [r.version, r.outcome])).toEqual([
      [2, 'new_version'],
      [3, 'new_version'],
    ]);
    expect(await history(v1.proposal_id)).toEqual([
      { version: 1, payload: { n: 1 } },
      { version: 2, payload: { n: 2 } },
      { version: 3, payload: { n: 3 } },
    ]);
    // Invariant: the current copy equals its own row in proposal_versions.
    expect(await current(v1.proposal_id)).toEqual({ version: 3, payload: { n: 3 }, status: 'pending' });
  });

  it('treats a changed precondition as a different plan', async () => {
    const key = subject();
    const v1 = await upsert(draft(key));
    const v2 = await upsert({ ...draft(key), preconditions: { catalog: { absent_items: ['oat milk'] } } });
    expect(v2).toMatchObject({ proposal_id: v1.proposal_id, version: 2 });
  });

  it('keeps different subjects as separate pending proposals (R23)', async () => {
    const a = await upsert(draft(subject()));
    const b = await upsert(draft(subject()));
    expect(a.proposal_id).not.toBe(b.proposal_id);
    expect((await current(a.proposal_id))?.status).toBe('pending');
    expect((await current(b.proposal_id))?.status).toBe('pending');
  });

  it('expires a stale pending proposal lazily and starts a fresh one', async () => {
    const key = subject();
    const old = await upsert(draft(key));
    await withAdmin((admin) =>
      admin.query(`UPDATE pantry.proposals SET expires_at = now() - interval '1 second' WHERE id = $1`, [old.proposal_id]),
    );
    const fresh = await upsert(draft(key));
    expect(fresh).toMatchObject({ version: 1, outcome: 'created' });
    expect(fresh.proposal_id).not.toBe(old.proposal_id);
    expect((await current(old.proposal_id))?.status).toBe('expired');
  });

  it('serializes concurrent first proposals for one subject into one pending card', async () => {
    const key = subject();
    // The first transaction holds its uncommitted insert; the second blocks on the unique index,
    // hits the violation, rolls back to its savepoint and updates the committed row instead.
    const slow = withTransaction(pool, async (tx) => {
      const ref = await upsertProposal(tx, householdId, draft(key, { from: 'slow' }));
      await tx.query('SELECT pg_sleep(0.3)');
      return ref;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fast = upsert(draft(key, { from: 'fast' }));
    const [a, b] = await Promise.all([slow, fast]);

    expect(b.proposal_id).toBe(a.proposal_id);
    expect([a.version, b.version]).toEqual([1, 2]);
    const pending = await pool.query(
      `SELECT count(*)::int AS n FROM pantry.proposals WHERE household_id = $1 AND subject_key = $2 AND status = 'pending'`,
      [householdId, key],
    );
    expect(pending.rows[0].n).toBe(1);
    expect((await history(a.proposal_id)).map((h) => h.payload)).toEqual([{ from: 'slow' }, { from: 'fast' }]);
  });

  it('propagates insert errors other than the subject race', async () => {
    const bad = { ...draft(subject()), kind: 'teleport' as ProposalDraft['kind'] };
    await expect(upsert(bad)).rejects.toMatchObject({ code: '23514' }); // check_violation
  });

  it('rolls back the version row together with the current copy', async () => {
    const key = subject();
    const v1 = await upsert(draft(key, { n: 1 }));
    await expect(
      withTransaction(pool, async (tx) => {
        await upsertProposal(tx, householdId, draft(key, { n: 2 }));
        throw new Error('later step failed');
      }),
    ).rejects.toThrow('later step failed');
    expect(await history(v1.proposal_id)).toHaveLength(1);
    expect((await current(v1.proposal_id))?.version).toBe(1);
  });
});
