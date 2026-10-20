// add_to_shopping_list (§7.4): appends rows, once per request_id.
import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type RunningServers, startServers } from '../../src/app.ts';
import { parseErrorResult } from '../../src/mcp/toolkit.ts';
import {
  callWrite,
  connectMcpClient,
  createDemoKitchen,
  type DemoKitchen,
  mcpTestConfig,
  startPasta,
  withAdmin,
} from '../../../../test/fixtures.ts';

describe('add_to_shopping_list', () => {
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

  const rows = async () =>
    withAdmin(async (admin) =>
      (
        await admin.query(
          `SELECT item_id, free_text, quantity::float AS quantity, unit, source, session_id FROM pantry.shopping_list_items
            WHERE household_id = $1 ORDER BY created_at, free_text NULLS FIRST`,
          [kitchen.householdId],
        )
      ).rows,
    );

  it('adds catalog items and free text, and says what it added', async () => {
    const res = await callWrite(client, 'add_to_shopping_list', { items: [{ name: 'eggs', quantity: 12 }, { name: 'dish soap' }] });
    expect(parseErrorResult(res)).toBeNull();
    expect(res.structuredContent).toEqual({
      items: [
        { id: expect.any(String), item: 'egg', known: true, quantity: 12, unit: 'count' },
        { id: expect.any(String), item: 'dish soap', known: false, quantity: null, unit: null },
      ],
    });
    expect((res.content as Array<{ text: string }>)[0]!.text).toBe('Added egg and dish soap to the shopping list.');
    expect(await rows()).toEqual([
      { item_id: kitchen.items.egg, free_text: null, quantity: 12, unit: 'count', source: 'manual', session_id: null },
      { item_id: null, free_text: 'dish soap', quantity: null, unit: null, source: 'manual', session_id: null },
    ]);
  });

  it('adds rows once per request_id, however often the call is retried (G12)', async () => {
    const ids = { requestId: randomUUID() };
    const first = await callWrite(client, 'add_to_shopping_list', { items: [{ name: 'milk', quantity: 1, unit: 'l' }] }, ids);
    const again = await callWrite(client, 'add_to_shopping_list', { items: [{ name: 'milk', quantity: 1, unit: 'l' }] }, ids);
    expect(again).toEqual(first);
    expect(await rows()).toHaveLength(1);
    await callWrite(client, 'add_to_shopping_list', { items: [{ name: 'milk', quantity: 1, unit: 'l' }] });
    expect(await rows()).toHaveLength(2); // a new request appends again
  });

  it('marks items short for a meal as shortfall, and refuses an unknown session', async () => {
    const sessionId = await startPasta(kitchen, client);
    expect(parseErrorResult(await callWrite(client, 'add_to_shopping_list', { items: [{ name: 'parmesan' }], session_id: sessionId }))).toBeNull();
    expect(await rows()).toEqual([expect.objectContaining({ source: 'shortfall', session_id: sessionId })]);
    const unknown = await callWrite(client, 'add_to_shopping_list', { items: [{ name: 'parmesan' }], session_id: randomUUID() });
    expect(parseErrorResult(unknown)?.code).toBe('not_found');
  });
});
