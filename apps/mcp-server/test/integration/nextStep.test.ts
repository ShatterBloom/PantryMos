// next_step: exactly one step per request, never past the end, guarded by expected_step (FR-12;
// R10, R24, R31, R32).
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
  stockKitchen,
  withAdmin,
} from '../../../../test/fixtures.ts';

interface StepResult {
  session_id: string;
  step_no: number;
  total_steps: number;
  step_text: string;
  timer_seconds: number | null;
  timer_label: string | null;
  done: boolean;
  ask: string | null;
}

describe('next_step', () => {
  let servers: RunningServers;
  beforeAll(async () => {
    servers = await startServers(mcpTestConfig(), { log: false });
  });
  afterAll(async () => servers.close());

  let kitchen: DemoKitchen;
  let client: Client;
  let sessionId: string;
  beforeEach(async () => {
    kitchen = await createDemoKitchen();
    client = await connectMcpClient(servers, kitchen.token);
    await client.listTools();
    sessionId = await startPasta(kitchen, client);
    return () => client.close();
  });

  const next = (expected_step: number, requestId?: string) =>
    callWrite(client, 'next_step', { expected_step }, requestId ? { requestId } : {});
  const step = (res: Awaited<ReturnType<typeof next>>) => res.structuredContent as unknown as StepResult;
  const currentStep = async () =>
    withAdmin(async (admin) =>
      Number((await admin.query(`SELECT current_step FROM pantry.cooking_sessions WHERE id = $1`, [sessionId])).rows[0].current_step),
    );

  it('advances one step and returns its timer (FR-12, FR-29)', async () => {
    const res = step(await next(1));
    expect(res).toEqual({
      session_id: sessionId,
      step_no: 2,
      total_steps: 6,
      step_text: 'Add the pasta and boil it until al dente, about 8 minutes.',
      timer_seconds: 480,
      timer_label: 'pasta',
      done: false,
      ask: null,
    });
    expect(await currentStep()).toBe(2);
  });

  it('reads a step with the substitute in place of the ingredient it stands in for', async () => {
    await stockKitchen(kitchen, { onion: 2 });
    const swapped = await callWrite(client, 'substitute', { from_item: 'scallion', to_item: 'onion', chosen_by_user: true });
    expect(swapped.isError).toBeFalsy();
    await next(1);
    const third = step(await next(2));
    expect(third.step_text).toBe('Meanwhile, melt the butter in a pan and soften the garlic and onion.');
    const session = (await callWrite(client, 'get_session', {})).structuredContent as { step_text: string };
    expect(session.step_text).toBe(third.step_text);
  });

  it('advances only once when the same request is retried (R10)', async () => {
    const requestId = randomUUID();
    const first = await next(1, requestId);
    const retry = await next(1, requestId);
    expect(retry).toEqual(first);
    expect(await currentStep()).toBe(2);
  });

  it('reports the current step instead of advancing when the user heard an older one (R31)', async () => {
    await next(1);
    await next(2);
    const res = await next(2);
    expect(parseErrorResult(res)).toEqual({
      code: 'step_conflict',
      message: 'The recipe is on step 3, not 2.',
      current_step: 3,
      step_text: 'Meanwhile, melt the butter in a pan and soften the garlic and scallions.',
    });
    expect(await currentStep()).toBe(3);
  });

  it('lets one of two concurrent "next" requests advance; the other gets step_conflict (R32)', async () => {
    await next(1);
    const results = await Promise.all([next(2), next(2)]);
    const errors = results.map(parseErrorResult);
    expect(errors.filter((e) => e === null)).toHaveLength(1);
    expect(errors.find((e) => e !== null)).toMatchObject({ code: 'step_conflict', current_step: 3 });
    expect(await currentStep()).toBe(3);
  });

  it('stays on the last step and asks the user to say when they are done (R24)', async () => {
    for (let s = 1; s < 6; s++) await next(s);
    for (let i = 0; i < 3; i++) {
      const res = step(await next(6));
      expect(res).toMatchObject({ step_no: 6, done: true, ask: "That was the last step. Tell me when you're done." });
    }
    expect(await currentStep()).toBe(6);
  });

  it('refuses while the consumption card is waiting', async () => {
    await withAdmin((admin) =>
      admin.query(`UPDATE pantry.cooking_sessions SET state = 'awaiting_confirmation' WHERE id = $1`, [sessionId]),
    );
    expect(parseErrorResult(await next(1))).toMatchObject({ code: 'invalid_state', state: 'awaiting_confirmation' });
  });

  it('needs an active session, and refuses a finished one by id', async () => {
    await withAdmin((admin) => admin.query(`UPDATE pantry.cooking_sessions SET state = 'cancelled' WHERE id = $1`, [sessionId]));
    expect(parseErrorResult(await next(1))?.code).toBe('no_active_session');
    const byId = await callWrite(client, 'next_step', { session_id: sessionId, expected_step: 1 });
    expect(parseErrorResult(byId)).toMatchObject({ code: 'invalid_state', state: 'cancelled' });
  });

  it('requires expected_step', async () => {
    const res = await callWrite(client, 'next_step', {});
    expect(res.isError).toBe(true);
  });
});
