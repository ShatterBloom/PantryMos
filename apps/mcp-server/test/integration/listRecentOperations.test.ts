// list_recent_operations: the ledger's operations, newest first, described from their events (§7.4).
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
  internalCall,
  mcpTestConfig,
  PASTA_STOCK,
  startPasta,
  stockKitchen,
  withAdmin,
} from '../../../../test/fixtures.ts';

interface Listed {
  operations: Array<{
    operation_id: string;
    kind: string;
    summary: string;
    changes: Array<{ item: string; delta: number; unit: string }>;
    session_id: string | null;
    reverted: boolean;
    created_at: string;
  }>;
}

describe('list_recent_operations', () => {
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

  const list = async (args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name: 'list_recent_operations', arguments: args });
    expect(parseErrorResult(res)).toBeNull();
    return { out: res.structuredContent as unknown as Listed, text: (res.content as Array<{ text: string }>)[0]!.text };
  };

  it('says so when nothing has been recorded', async () => {
    expect(await list()).toEqual({ out: { operations: [] }, text: 'Nothing has been recorded yet.' });
  });

  it('lists a confirmed meal first, with its recipe, session and net changes', async () => {
    const sessionId = await startPasta(kitchen, client);
    const card = (await callWrite(client, 'propose_consumption', { overrides: [{ item: 'parmesan', quantity: 0 }] }))
      .structuredContent as { proposal_id: string };
    const confirmed = await internalCall(servers, `/internal/proposals/${card.proposal_id}/confirm`, {
      version: 1, user_id: 'demo', channel: 'ui_click', request_id: randomUUID(),
    });
    expect(confirmed.status).toBe(200);

    const { out, text } = await list({ limit: 10 });
    const [meal, ...intakes] = out.operations;
    expect(meal).toMatchObject({
      operation_id: confirmed.body.operation_id,
      kind: 'consume',
      session_id: sessionId,
      reverted: false,
    });
    expect(meal!.changes).toContainEqual({ item: 'pasta', delta: -300, unit: 'g' });
    expect(meal!.changes.some((c) => c.item === 'parmesan')).toBe(false);
    expect(meal!.summary).toMatch(/^Cooked creamy spinach pasta: .*−300 grams of pasta/);
    expect(text).toBe(`Latest: ${meal!.summary}.`);
    expect(intakes.every((o) => o.kind === 'intake' && o.changes.length === 1 && o.changes[0]!.delta > 0)).toBe(true);
  });

  it('caps the list, marks reverted operations and never shows another household', async () => {
    await stockKitchen(kitchen, PASTA_STOCK);
    const other = await createDemoKitchen();
    await stockKitchen(other, { egg: 12 });

    const { out } = await list({ limit: 3 });
    expect(out.operations).toHaveLength(3);
    const all = (await list({ limit: 10 })).out.operations;
    expect(all).toHaveLength(Object.keys(PASTA_STOCK).length);
    expect(all.some((o) => o.changes.some((c) => c.item === 'egg'))).toBe(false);

    const [latest] = out.operations;
    // Mark it reverted the way an undo does (replaced by a real undo once propose_undo exists).
    await withAdmin((admin) =>
      admin.query(`UPDATE pantry.operations SET reverted_by_op = id WHERE id = $1`, [latest!.operation_id]),
    );
    const again = await list({ limit: 1 });
    expect(again.out.operations[0]).toMatchObject({ operation_id: latest!.operation_id, reverted: true });
    expect(again.text).toMatch(/\(undone\)\.$/);
  });
});
