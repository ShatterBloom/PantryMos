// Read tools list_inventory and expiring_soon (stories B3–B5) against real data.
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningServers, startServers } from '../../src/app.ts';
import { addDays, daysBetween, formatShort } from '../../src/domain/dates.ts';
import {
  connectMcpClient,
  createBatch,
  createHousehold,
  createItem,
  mcpTestConfig,
  todayIn,
} from '../../../../test/fixtures.ts';

interface InventoryOut {
  today: string;
  items: Array<{
    item: string;
    total: number;
    unit: string;
    batches: Array<{ batch_id: string; quantity: number; date_label: string; priority_source: string }>;
  }>;
}

interface ExpiringOut {
  today: string;
  within_days: number;
  batches: Array<{ batch_id: string; item: string; quantity: number; priority_date: string; date_label: string }>;
}

const TZ = 'America/Los_Angeles';

describe('inventory read tools', () => {
  let servers: RunningServers;
  let client: Client;
  let today: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const hh = await createHousehold(TZ);
    const h = hh.householdId;
    today = await todayIn(TZ);
    servers = await startServers(mcpTestConfig(), { log: false });
    client = await connectMcpClient(servers, hh.token);

    const egg = await createItem(h, { name: 'egg', default_shelf_days: 21 });
    const milk = await createItem(h, { name: 'milk', base_unit: 'ml', default_shelf_days: 7 });
    const spinach = await createItem(h, { name: 'spinach', base_unit: 'g', default_shelf_days: 5 });
    await createItem(h, { name: 'red pepper', aliases: ['pepper'] });
    await createItem(h, { name: 'black pepper', aliases: ['pepper'] });
    const rice = await createItem(h, { name: 'rice', base_unit: 'g', default_shelf_days: 365 });

    // Two milk cartons with different package dates (FEFO order: B before A by priority date).
    ids.milkLate = await createBatch(h, milk, {
      quantity: 1000,
      purchased_at: addDays(today, -1),
      package_date: addDays(today, 10),
      package_date_type: 'use_by',
    });
    ids.milkEarly = await createBatch(h, milk, {
      quantity: 500,
      purchased_at: addDays(today, -3),
      opened_at: addDays(today, -1),
      package_date: addDays(today, 2),
      package_date_type: 'best_by',
    });
    // Spinach without a package date: estimated priority = purchased + 5 days = overdue.
    ids.spinach = await createBatch(h, spinach, { quantity: 200, purchased_at: addDays(today, -6) });
    ids.egg = await createBatch(h, egg, { quantity: 12, purchased_at: today });
    ids.rice = await createBatch(h, rice, { quantity: 1000, purchased_at: addDays(today, -30) });
    // Excluded: depleted and discarded batches.
    await createBatch(h, egg, { quantity: 0, purchased_at: addDays(today, -10) });
    await createBatch(h, egg, { quantity: 6, purchased_at: addDays(today, -2), status: 'discarded' });
  });
  afterAll(async () => {
    await client.close();
    await servers.close();
  });

  const listInventory = async (args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name: 'list_inventory', arguments: args });
    return { res, out: res.structuredContent as InventoryOut };
  };
  const expiringSoon = async (args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name: 'expiring_soon', arguments: args });
    return { res, out: res.structuredContent as ExpiringOut };
  };

  describe('list_inventory', () => {
    it('returns every in-stock item sorted by name, with totals, and the household today', async () => {
      const { out } = await listInventory();
      expect(out.today).toBe(today);
      expect(out.items.map((i) => [i.item, i.total, i.unit])).toEqual([
        ['egg', 12, 'count'],
        ['milk', 1500, 'ml'],
        ['rice', 1000, 'g'],
        ['spinach', 200, 'g'],
      ]);
    });

    it('lists batches of one item in FEFO order with labels from their date source (B3)', async () => {
      const { out } = await listInventory({ item: 'milk' });
      expect(out.items[0]?.batches).toEqual([
        {
          batch_id: ids.milkEarly,
          quantity: 500,
          date_label: `best by ${formatShort(addDays(today, 2))} (from package), opened ${formatShort(addDays(today, -1))}`,
          priority_source: 'package',
        },
        {
          batch_id: ids.milkLate,
          quantity: 1000,
          date_label: `use by ${formatShort(addDays(today, 10))} (from package)`,
          priority_source: 'package',
        },
      ]);
    });

    it('never states an expiry date for a batch without a package date (B3)', async () => {
      const { out } = await listInventory({ item: 'spinach' });
      expect(out.items[0]?.batches[0]).toMatchObject({
        date_label: 'stored for 6 days, no package date',
        priority_source: 'estimate',
      });
      const { out: eggs } = await listInventory({ item: 'eggs' });
      expect(eggs.items[0]?.batches[0]?.date_label).toBe('bought today, no package date');
    });

    it('excludes depleted and discarded batches', async () => {
      const { out } = await listInventory({ item: 'egg' });
      expect(out.items[0]?.batches.map((b) => b.batch_id)).toEqual([ids.egg]);
    });

    it('says there is no record for an unknown item, without an error (B4)', async () => {
      const { res, out } = await listInventory({ item: 'salmon' });
      expect(res.isError).toBeFalsy();
      expect(out.items).toEqual([]);
      expect(res.content).toEqual([{ type: 'text', text: 'There is no record of salmon in the pantry.' }]);
    });

    it('distinguishes a known item that is out of stock', async () => {
      const { res, out } = await listInventory({ item: 'black pepper' });
      expect(out.items).toEqual([]);
      expect(res.content).toEqual([{ type: 'text', text: 'There is no black pepper in stock.' }]);
    });

    it('asks which item is meant when the name is ambiguous', async () => {
      const { res } = await listInventory({ item: 'pepper' });
      expect(res.isError).toBe(true);
      expect(res.structuredContent).toMatchObject({
        code: 'ambiguous_item',
        options: ['black pepper', 'red pepper'],
        ask: 'Which one do you mean: black pepper or red pepper?',
      });
    });
  });

  describe('expiring_soon', () => {
    it('lists batches due within 3 days by default, earliest first, including overdue (B5)', async () => {
      const { out, res } = await expiringSoon();
      expect(out.within_days).toBe(3);
      expect(out.batches.map((b) => b.batch_id)).toEqual([ids.spinach, ids.milkEarly]);
      expect(out.batches[0]).toEqual({
        batch_id: ids.spinach,
        item: 'spinach',
        quantity: 200,
        unit: 'g',
        priority_date: addDays(today, -1),
        priority_source: 'estimate',
        date_label: 'stored for 6 days, no package date',
      });
      expect((res.content as Array<{ text: string }>)[0]?.text).toMatch(/^Use first: spinach \(stored for 6 days/);
    });

    it('widens the window on request', async () => {
      const { out } = await expiringSoon({ within_days: 21 });
      expect(out.batches.map((b) => b.item)).toEqual(['spinach', 'milk', 'milk', 'egg']);
      for (const b of out.batches) expect(daysBetween(today, b.priority_date)).toBeLessThanOrEqual(21);
    });
  });
});

describe('household timezone (§2.4)', () => {
  it('computes today and storage age in each household timezone', async () => {
    // UTC+14 and UTC−11 are always on different calendar dates.
    const zones = ['Pacific/Kiritimati', 'Pacific/Pago_Pago'];
    const servers = await startServers(mcpTestConfig(), { log: false });
    try {
      const results = [];
      for (const tz of zones) {
        const hh = await createHousehold(tz);
        const tzToday = await todayIn(tz);
        const bread = await createItem(hh.householdId, { name: 'bread' });
        await createBatch(hh.householdId, bread, { quantity: 1, purchased_at: addDays(tzToday, -2) });
        const client = await connectMcpClient(servers, hh.token);
        const out = (await client.callTool({ name: 'list_inventory', arguments: {} })).structuredContent as InventoryOut;
        await client.close();
        results.push({ tzToday, out });
      }
      for (const { tzToday, out } of results) {
        expect(out.today).toBe(tzToday);
        expect(out.items[0]?.batches[0]?.date_label).toBe('stored for 2 days, no package date');
      }
      expect(results[0]!.tzToday).not.toBe(results[1]!.tzToday);
    } finally {
      await servers.close();
    }
  });
});
