// Card edits (PATCH) and Refresh (regenerate), §4.4: R20 and R27 refresh halves, R29, R30.
import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type RunningServers, startServers } from '../../src/app.ts';
import { parseErrorResult } from '../../src/mcp/toolkit.ts';
import {
  adjustStock,
  callWrite,
  connectMcpClient,
  createDemoKitchen,
  type DemoKitchen,
  internalCall,
  ledgerMismatches,
  mcpTestConfig,
  startPasta,
  stockKitchen,
  withAdmin,
} from '../../../../test/fixtures.ts';

interface CardResult {
  proposal_id: string;
  version: number;
  kind: string;
  outcome: string;
  card: { readback_text: string; warnings: string[]; lines: string[] };
  regenerated_from?: string;
}

describe('edit and regenerate cards', () => {
  let servers: RunningServers;
  beforeAll(async () => {
    servers = await startServers(mcpTestConfig(), { log: false });
  });
  afterAll(async () => servers.close());

  let kitchen: DemoKitchen;
  let client: Client;
  beforeEach(async () => {
    kitchen = await createDemoKitchen();
    client = await connectMcpClient(servers, kitchen.token);
    return () => client.close();
  });

  const propose = async (name: string, args: Record<string, unknown>, conversationId?: string) => {
    const res = await callWrite(client, name, args, conversationId ? { conversationId } : {});
    expect(parseErrorResult(res)).toBeNull();
    return res.structuredContent as unknown as CardResult;
  };
  const edit = (id: string, base_version: number, changes: unknown, requestId = randomUUID()) =>
    internalCall(servers, `/internal/proposals/${id}`, { base_version, changes, request_id: requestId }, 'PATCH');
  const regenerate = (id: string, requestId = randomUUID()) =>
    internalCall(servers, `/internal/proposals/${id}/regenerate`, { request_id: requestId });
  const confirm = (id: string, version: number) =>
    internalCall(servers, `/internal/proposals/${id}/confirm`, { version, user_id: 'demo', channel: 'ui_click', request_id: randomUUID() });
  const versions = async (id: string) =>
    withAdmin(async (admin) =>
      (await admin.query(`SELECT version FROM pantry.proposal_versions WHERE proposal_id = $1 ORDER BY version`, [id])).rows.map(
        (r) => r.version,
      ),
    );
  /** Invariant (§4.1): every proposal's current (id, version) has an identical proposal_versions row. */
  const versionInvariantBroken = async () =>
    withAdmin(async (admin) =>
      (
        await admin.query(
          `SELECT p.id FROM pantry.proposals p
             LEFT JOIN pantry.proposal_versions v ON v.proposal_id = p.id AND v.version = p.version
            WHERE p.household_id = $1 AND p.subject_key NOT LIKE 'fixture:%'
              AND (v.proposal_id IS NULL OR v.payload <> p.payload OR v.preconditions <> p.preconditions)`,
          [kitchen.householdId],
        )
      ).rows,
    );

  describe('PATCH (card edit)', () => {
    it('re-plans an intake card from the edited items as a new version (R29)', async () => {
      const v1 = await propose('propose_intake', { items: [{ name: 'egg', quantity: 6 }] });
      const res = await edit(v1.proposal_id, 1, { items: [{ name: 'egg', quantity: 12 }, { name: 'tomato', quantity: 2 }] });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ proposal_id: v1.proposal_id, version: 2, kind: 'intake', outcome: 'new_version' });
      expect((res.body as unknown as CardResult).card.readback_text).toBe(
        "I'll add 12 eggs and 2 tomatoes. Say confirm, or tell me what to change.",
      );
      expect(await confirm(v1.proposal_id, 1)).toMatchObject({ status: 409, body: { code: 'stale_proposal' } });
      expect(await confirm(v1.proposal_id, 2)).toMatchObject({ status: 200, body: { version: 2 } });
      const op = await withAdmin(async (admin) =>
        (await admin.query(`SELECT proposal_version FROM pantry.operations WHERE proposal_id = $1`, [v1.proposal_id])).rows,
      );
      expect(op).toEqual([{ proposal_version: 2 }]); // the ledger records which version was confirmed
    });

    it('merges consume edits with earlier ones and keeps the session waiting', async () => {
      const sessionId = await startPasta(kitchen, client);
      const v1 = await propose('propose_consumption', {});
      const v2 = (await edit(v1.proposal_id, 1, { overrides: [{ item: 'pasta', quantity: 250 }] })).body as unknown as CardResult;
      const v3 = (await edit(v1.proposal_id, 2, { overrides: [{ item: 'milk', quantity: 200 }] })).body as unknown as CardResult;
      expect([v2.version, v3.version]).toEqual([2, 3]);
      expect(v3.card.readback_text).toContain('250 grams of pasta');
      expect(v3.card.readback_text).toContain('200 milliliters of milk');
      const session = await withAdmin(async (admin) =>
        (await admin.query(`SELECT state FROM pantry.cooking_sessions WHERE id = $1`, [sessionId])).rows[0].state,
      );
      expect(session).toBe('awaiting_confirmation');
      expect((await confirm(v1.proposal_id, 3)).status).toBe(200);
    });

    it('keeps the version for an edit that changes nothing', async () => {
      const v1 = await propose('propose_intake', { items: [{ name: 'egg', quantity: 6 }] });
      const res = await edit(v1.proposal_id, 1, { items: [{ name: 'eggs', quantity: 6, unit: 'count' }] });
      expect(res.body).toMatchObject({ version: 1, outcome: 'unchanged' });
    });

    it('refuses an edit of an older version, of a confirmed card, and of an expired one', async () => {
      const v1 = await propose('propose_intake', { items: [{ name: 'egg', quantity: 6 }] });
      await edit(v1.proposal_id, 1, { items: [{ name: 'egg', quantity: 7 }] });
      expect(await edit(v1.proposal_id, 1, { items: [{ name: 'egg', quantity: 8 }] })).toMatchObject({
        status: 409,
        body: { code: 'stale_proposal', current_version: 2 },
      });
      await confirm(v1.proposal_id, 2);
      expect((await edit(v1.proposal_id, 2, { items: [{ name: 'egg', quantity: 8 }] })).body).toMatchObject({ code: 'already_committed' });

      const old = await propose('propose_intake', { items: [{ name: 'egg', quantity: 1 }] });
      await withAdmin((admin) => admin.query(`UPDATE pantry.proposals SET expires_at = now() - interval '1 second' WHERE id = $1`, [old.proposal_id]));
      expect(await edit(old.proposal_id, 1, { items: [{ name: 'egg', quantity: 2 }] })).toMatchObject({ status: 409, body: { code: 'expired' } });
    });

    it('leaves the card unchanged when the edit is impossible', async () => {
      await startPasta(kitchen, client);
      const v1 = await propose('propose_consumption', {});
      const res = await edit(v1.proposal_id, 1, { overrides: [{ item: 'milk', quantity: 99_999 }] });
      expect(res).toMatchObject({ status: 409, body: { code: 'insufficient_stock' } });
      expect(await versions(v1.proposal_id)).toEqual([1]);
      expect((await confirm(v1.proposal_id, 1)).status).toBe(200);
    });

    it('rejects malformed changes before touching the card', async () => {
      const v1 = await propose('propose_intake', { items: [{ name: 'egg', quantity: 6 }] });
      expect((await edit(v1.proposal_id, 1, { items: [] })).status).toBe(400);
      expect((await edit(v1.proposal_id, 1, { overrides: [] })).status).toBe(400);
      expect((await edit(randomUUID(), 1, { items: [{ name: 'egg' }] })).status).toBe(404);
      expect(await versions(v1.proposal_id)).toEqual([1]);
    });
  });

  describe('regenerate (Refresh)', () => {
    it('rebuilds a stale consume card from current stock (R20)', async () => {
      await stockKitchen(kitchen, { milk: 1000 }, 5); // older carton, used first
      await startPasta(kitchen, client); // adds a newer carton with the rest of the stock
      const stale = await propose('propose_consumption', {});
      const [older] = await withAdmin(async (admin) =>
        (
          await admin.query(`SELECT id FROM pantry.batches WHERE item_id = $1 ORDER BY purchased_at LIMIT 1`, [kitchen.items.milk])
        ).rows,
      );
      expect((await adjustStock(servers, client, { batch_id: older.id, delta: -1000, reason: 'discard' })).status).toBe(200);
      expect(await confirm(stale.proposal_id, 1)).toMatchObject({ status: 409, body: { code: 'stale_state' } });

      const fresh = (await regenerate(stale.proposal_id)).body as unknown as CardResult;
      expect(fresh).toMatchObject({ version: 1, kind: 'consume', outcome: 'created', regenerated_from: stale.proposal_id });
      expect(fresh.proposal_id).not.toBe(stale.proposal_id);
      expect((await confirm(fresh.proposal_id, 1)).status).toBe(200);
      expect(await ledgerMismatches(kitchen.householdId)).toEqual([]);
    });

    it('resolves a new item to the one created meanwhile (R27 refresh)', async () => {
      const newItem = { name: 'oat milk', quantity: 1, unit: 'l', new_item: { category: 'dairy', base_unit: 'ml' } };
      const a = await propose('propose_intake', { items: [newItem] });
      const b = await propose('propose_intake', { items: [newItem] });
      await confirm(a.proposal_id, 1);
      expect((await confirm(b.proposal_id, 1)).body).toMatchObject({ code: 'stale_state', reason: 'catalog_changed' });

      const fresh = (await regenerate(b.proposal_id)).body as unknown as CardResult;
      expect(fresh.card.warnings).toEqual([]); // no longer a new item
      expect((await confirm(fresh.proposal_id, 1)).status).toBe(200);
      const items = await withAdmin(async (admin) =>
        admin.query(`SELECT 1 FROM pantry.items WHERE household_id = $1 AND name = 'oat milk'`, [kitchen.householdId]),
      );
      expect(items.rowCount).toBe(1);
    });

    it('keeps every version of the original and gives the refreshed card its own v1 (R30)', async () => {
      const conversationId = randomUUID();
      const card = await propose('propose_intake', { items: [{ name: 'egg', quantity: 6 }] }, conversationId);
      await edit(card.proposal_id, 1, { items: [{ name: 'egg', quantity: 7 }] });
      await edit(card.proposal_id, 2, { items: [{ name: 'egg', quantity: 8 }] });
      await withAdmin((admin) => admin.query(`UPDATE pantry.proposals SET status = 'stale', stale_reason = 'test' WHERE id = $1`, [card.proposal_id]));
      const fresh = (await regenerate(card.proposal_id)).body as unknown as CardResult;

      expect(await versions(card.proposal_id)).toEqual([1, 2, 3]);
      expect(await versions(fresh.proposal_id)).toEqual([1]);
      expect(fresh.card.readback_text).toContain('8 eggs'); // from the latest stored input
      expect(await versionInvariantBroken()).toEqual([]);
    });

    it('refreshes an expired card, replays a retry, and refuses live cards', async () => {
      const live = await propose('propose_intake', { items: [{ name: 'egg', quantity: 6 }] });
      expect(await regenerate(live.proposal_id)).toMatchObject({ status: 409, body: { code: 'invalid_state', status: 'pending' } });

      await withAdmin((admin) => admin.query(`UPDATE pantry.proposals SET expires_at = now() - interval '1 second' WHERE id = $1`, [live.proposal_id]));
      const requestId = randomUUID();
      const fresh = await regenerate(live.proposal_id, requestId);
      expect(fresh).toMatchObject({ status: 200, body: { version: 1, regenerated_from: live.proposal_id } });
      expect(await regenerate(live.proposal_id, requestId)).toEqual(fresh);
      expect((await regenerate(randomUUID())).status).toBe(404);
    });

    it('returns the business error when the card cannot be rebuilt', async () => {
      await startPasta(kitchen, client);
      const card = await propose('propose_consumption', {});
      await withAdmin((admin) => admin.query(`UPDATE pantry.proposals SET status = 'stale' WHERE id = $1`, [card.proposal_id]));
      await callWrite(client, 'cancel_cooking', {});
      expect(await regenerate(card.proposal_id)).toMatchObject({ status: 409, body: { code: 'invalid_state' } });
    });
  });
});
