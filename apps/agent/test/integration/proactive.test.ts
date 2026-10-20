// Proactive engine (§8.6, §9.6): timers fire through the outbox, the event worker runs proactive turns.
// G7–G10, the attempt cap with its templated fallback, and the acknowledgement of a button confirm.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type RunningServers, startServers } from '@pantrymos/mcp-server';
import { createDemoKitchen, type DemoKitchen, mcpTestConfig, stockKitchen, withAdmin } from '../../../../test/fixtures.ts';
import { claimEvents, DEFAULT_WORKER_TIMING } from '../../src/workers.ts';
import { agentRows, callTools, cardAction, chat, lastMessage, messages, say, startAgent, type TestAgent } from '../fixtures.ts';

describe('proactive turns', () => {
  let servers: RunningServers;
  beforeAll(async () => {
    servers = await startServers(mcpTestConfig(), { log: false });
  });
  afterAll(async () => servers.close());

  const timing = { ...DEFAULT_WORKER_TIMING, claimMs: 100, proactiveGapMs: 10_000, maxAttempts: 3 };
  let kitchen: DemoKitchen;
  let agent: TestAgent;
  beforeEach(async () => {
    kitchen = await createDemoKitchen();
    agent = await startAgent(servers, kitchen, { workerTiming: timing });
  });
  afterEach(async () => agent.close());

  const startTimer = async (label: string, seconds = 600) => {
    agent.model.push(callTools(['start_timer', { label, seconds }]), say('Started.'));
    expect((await chat(agent, `set a ${label} timer`)).status).toBe(200);
  };
  const timer = async (label: string) =>
    (
      await agentRows<{ id: string; status: string; remaining_s: number | null; fires_in: number | null }>(
        agent,
        `SELECT id, status, remaining_s, ceil(extract(epoch FROM fires_at - now()))::int AS fires_in
           FROM agent.timers WHERE conversation_id = $1 AND label = $2`,
        [agent.conversationId, label],
      )
    )[0]!;
  const makeDue = (label: string) =>
    agent.pool.query(`UPDATE agent.timers SET fires_at = now() - interval '1 second' WHERE conversation_id = $1 AND label = $2`, [
      agent.conversationId,
      label,
    ]);
  /** One scheduler pass, then one worker pass, waiting for the turns it started. */
  const tick = async () => {
    await agent.workers.tickScheduler();
    await agent.workers.tickEvents();
    await agent.workers.drain();
  };
  const proactive = async () => (await messages(agent)).filter((m) => m.turn_type === 'proactive');
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('G8: a fired timer is announced, with only the proactive tools offered and no step advanced', async () => {
    await stockKitchen(kitchen, { egg: 6, tomato: 4, 'olive oil': 100, scallion: 2 });
    agent.model.push(callTools(['start_cooking', { recipe_name: 'tomato egg stir-fry' }]), say('Step 1.'));
    await chat(agent, 'cook the stir-fry');
    await startTimer('eggs');
    await makeDue('eggs');

    // The model tries to move on, and to start a timer nobody asked for; the turn refuses both.
    agent.model.push(
      callTools(['next_step'], ['start_timer', { label: 'rest', seconds: 60 }]),
      say("The eggs are done — say next when you're ready."),
    );
    await tick();

    const request = agent.model.requests.at(-2)!;
    expect(request.messages.at(-1)!.content).toEqual([{ text: '[app event] timer "eggs" finished.' }]);
    const offered = request.tools.map((t) => t.name).sort();
    expect(offered).toEqual(
      ['expiring_soon', 'get_session', 'list_inventory', 'list_recent_operations', 'list_timers', 'propose_consumption', 'suggest_recipes'].sort(),
    );
    const refused = agent.model.requests.at(-1)!.messages.at(-1)!.content as unknown as Array<{ toolResult: unknown }>;
    expect(refused.map((b) => b.toolResult)).toEqual([
      expect.objectContaining({ status: 'error', content: [{ json: expect.objectContaining({ code: 'tool_not_allowed' }) }] }),
      expect.objectContaining({ status: 'error', content: [{ json: expect.objectContaining({ code: 'tool_not_allowed' }) }] }),
    ]);
    expect(await agentRows(agent, `SELECT label FROM agent.timers WHERE conversation_id = $1`, [agent.conversationId])).toEqual([{ label: 'eggs' }]);

    expect(await proactive()).toEqual([
      expect.objectContaining({ speech: "The eggs are done — say next when you're ready.", cards: [], voice_prompt: null }),
    ]);
    const [session] = await withAdmin(async (admin) =>
      (await admin.query(`SELECT current_step, state FROM pantry.cooking_sessions WHERE household_id = $1`, [kitchen.householdId])).rows,
    );
    expect(session).toEqual({ current_step: 1, state: 'cooking' });
    expect(await timer('eggs')).toMatchObject({ status: 'fired' });
    const [event] = await agentRows(
      agent,
      `SELECT delivered_at IS NOT NULL AS delivered, turn_done_at IS NOT NULL AS done FROM agent.app_events WHERE conversation_id = $1`,
      [agent.conversationId],
    );
    expect(event).toEqual({ delivered: true, done: true });
  });

  it('G9: an event whose turn crashed is claimed again and announced once', async () => {
    await startTimer('pasta');
    await makeDue('pasta');
    agent.model.push(() => {
      throw new Error('model unavailable');
    });
    await tick();
    expect(await proactive()).toEqual([]);

    await wait(150); // the claim runs out
    agent.model.push(say('Your pasta timer is done.'));
    await tick();
    await wait(150);
    await tick(); // nothing left to claim
    expect((await proactive()).map((m) => m.speech)).toEqual(['Your pasta timer is done.']);
    // The event's block reached the model's history once, though two attempts ran.
    const blocks = await agentRows<{ n: number }>(
      agent,
      `SELECT count(*)::int AS n FROM agent.conversation_messages WHERE conversation_id = $1 AND content::text LIKE '%[app event] timer%'`,
      [agent.conversationId],
    );
    expect(blocks).toEqual([{ n: 1 }]);
  });

  it('after the last failed attempt, says something templated and gives up', async () => {
    await startTimer('rice');
    await makeDue('rice');
    for (let attempt = 0; attempt < 3; attempt++) {
      agent.model.push(() => {
        throw new Error('model unavailable');
      });
      await tick();
      await wait(150);
    }
    await tick();
    expect((await proactive()).map((m) => m.speech)).toEqual(["Timer 'rice' is done."]);
    expect(await agentRows(agent, `SELECT turn_failed, turn_attempts FROM agent.app_events WHERE conversation_id = $1`, [agent.conversationId])).toEqual([
      { turn_failed: true, turn_attempts: 3 },
    ]);
  });

  it('says the templated line when the model has nothing to say about an event', async () => {
    await startTimer('rice');
    await makeDue('rice');
    agent.model.push(...Array.from({ length: 3 }, () => ({ stopReason: 'end_turn', content: [] })));
    await tick();
    expect((await proactive()).map((m) => m.speech)).toEqual(["Timer 'rice' is done."]);
  });

  /** Claims the conversation's events as a worker would, then "dies" before running a turn. */
  const claimAndDie = async () => {
    await claimEvents(agent.pool, kitchen.householdId, timing, []);
    await wait(150); // the claim runs out
  };
  const eventRows = () =>
    agentRows<{ label: string; turn_failed: boolean; turn_attempts: number }>(
      agent,
      `SELECT payload ->> 'label' AS label, turn_failed, turn_attempts FROM agent.app_events WHERE conversation_id = $1 ORDER BY created_at`,
      [agent.conversationId],
    );

  it('still says the fallback when the process died after the last claim', async () => {
    await startTimer('rice');
    await makeDue('rice');
    await agent.workers.tickScheduler();
    for (let attempt = 0; attempt < timing.maxAttempts; attempt++) await claimAndDie();

    await tick();
    await tick(); // said once
    expect((await proactive()).map((m) => m.speech)).toEqual(["Timer 'rice' is done."]);
    expect(await eventRows()).toEqual([{ label: 'rice', turn_failed: true, turn_attempts: 3 }]);
  });

  it('gives up only the coalesced events that used their last attempt', async () => {
    await startTimer('rice');
    await startTimer('pasta');
    await makeDue('rice');
    await agent.workers.tickScheduler();
    for (let attempt = 0; attempt < timing.maxAttempts - 1; attempt++) await claimAndDie();
    await makeDue('pasta');
    agent.model.push(() => {
      throw new Error('model unavailable');
    });
    await tick(); // one turn for both: rice's last attempt, pasta's first

    expect(agent.model.requests.at(-1)!.messages.at(-1)!.content).toHaveLength(2);
    expect((await proactive()).map((m) => m.speech)).toEqual(["Timer 'rice' is done."]);
    expect(await eventRows()).toEqual([
      { label: 'rice', turn_failed: true, turn_attempts: 3 },
      { label: 'pasta', turn_failed: false, turn_attempts: 1 },
    ]);
  });

  it('G10: pause, resume and cancel by voice keep the time left; a second pause changes nothing', async () => {
    await startTimer('stock', 600);
    agent.model.push(callTools(['pause_timer']), say('Paused.'));
    await chat(agent, 'pause the timer');
    const paused = await timer('stock');
    expect(paused).toMatchObject({ status: 'paused', fires_in: null });
    expect(paused.remaining_s).toBeGreaterThan(590);

    agent.model.push(callTools(['pause_timer', { label: 'Stock' }]), say('It is already paused.'));
    await chat(agent, 'pause it');
    expect(await timer('stock')).toEqual(paused);

    agent.model.push(callTools(['resume_timer']), say('Resumed.'));
    await chat(agent, 'resume');
    const resumed = await timer('stock');
    expect(resumed).toMatchObject({ status: 'running', remaining_s: null });
    expect(resumed.fires_in).toBeLessThanOrEqual(paused.remaining_s!);
    expect(resumed.fires_in).toBeGreaterThan(paused.remaining_s! - 5);

    agent.model.push(callTools(['cancel_timer', { timer_id: '00000000-0000-4000-8000-000000000000' }]), (req) => {
      const result = req.messages.at(-1)!.content[0] as unknown as { toolResult: { content: [{ json: Record<string, unknown> }] } };
      expect(result.toolResult.content[0].json).toMatchObject({ code: 'not_found' });
      return say('No such timer.');
    });
    await chat(agent, 'cancel that timer');
    agent.model.push(callTools(['cancel_timer', { seconds: 5 }]), (req) => {
      const result = req.messages.at(-1)!.content[0] as unknown as { toolResult: { content: [{ json: Record<string, unknown> }] } };
      expect(result.toolResult.content[0].json).toMatchObject({ code: 'invalid_input' });
      return say('Which timer?');
    });
    await chat(agent, 'cancel the 5 second timer');

    agent.model.push(callTools(['cancel_timer']), say('Cancelled.'));
    await chat(agent, 'cancel the timer');
    expect(await timer('stock')).toMatchObject({ status: 'cancelled', remaining_s: null, fires_in: null });
  });

  it('asks which timer when several are going, and lists them', async () => {
    await startTimer('pasta', 600);
    await startTimer('sauce', 300);
    agent.model.push(callTools(['pause_timer']), (req) => {
      const result = req.messages.at(-1)!.content[0] as unknown as { toolResult: { content: [{ json: Record<string, unknown> }] } };
      expect(result.toolResult.content[0].json).toMatchObject({ code: 'ambiguous_timer', ask: 'Which one: sauce or pasta?' });
      return say('Which one: sauce or pasta?');
    });
    await chat(agent, 'pause the timer');
    expect(await lastMessage(agent)).toMatchObject({ cards: [expect.objectContaining({ type: 'options', code: 'ambiguous_timer' })] });

    agent.model.push(callTools(['list_timers']), (req) => {
      const result = req.messages.at(-1)!.content[0] as unknown as {
        toolResult: { content: [{ json: { timers: Array<{ label: string }> } }] };
      };
      return say(result.toolResult.content[0].json.timers.map((t) => t.label).join(', '));
    });
    await chat(agent, 'what timers are running?');
    expect((await lastMessage(agent)).speech).toBe('sauce, pasta');
  });

  it('G7: an event during a user turn waits for it, then runs; a second one within 10 s waits too', async () => {
    await startTimer('pasta');
    await startTimer('sauce');
    await makeDue('pasta');

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    agent.model.push(async () => {
      await held;
      return say('Here is a long answer.');
    });
    const userTurn = chat(agent, 'tell me something');
    await wait(100);
    await agent.workers.tickScheduler();
    await agent.workers.tickEvents(); // claims the event; its turn waits for the lock
    agent.model.push(say('Pasta is ready.'));
    await wait(100);
    expect(await proactive()).toEqual([]);
    release();
    await userTurn;
    await agent.workers.drain();
    expect((await messages(agent)).slice(-2).map((m) => [m.turn_type, m.speech])).toEqual([
      ['user', 'Here is a long answer.'],
      ['proactive', 'Pasta is ready.'],
    ]);

    // Within 10 s of that proactive message, the next event is not claimed.
    await makeDue('sauce');
    await tick();
    expect(await proactive()).toHaveLength(1);
    const pending = await agentRows(agent, `SELECT kind FROM agent.app_events WHERE conversation_id = $1 AND turn_done_at IS NULL`, [
      agent.conversationId,
    ]);
    expect(pending).toEqual([{ kind: 'timer_fired' }]);
  });

  it('acknowledges a card confirmed by button with a proactive turn', async () => {
    agent.model.push(callTools(['propose_intake', { items: [{ name: 'egg', quantity: 6 }] }]), say('OK.'));
    await chat(agent, 'I bought 6 eggs');
    const card = (await lastMessage(agent)).voice_prompt as { proposal_id: string; version: number };

    const res = await cardAction(agent, 'POST', `/api/proposals/${card.proposal_id}/confirm`, { version: 1 });
    expect(res).toMatchObject({ status: 200, body: { status: 'committed', kind: 'intake' } });
    agent.model.push(say('Saved your 6 eggs.'));
    await tick();
    expect(agent.model.requests.at(-1)!.messages.at(-1)!.content).toEqual([
      { text: `[app event] proposal ${card.proposal_id} v1 (intake) committed.` },
    ]);
    expect((await proactive()).map((m) => m.speech)).toEqual(['Saved your 6 eggs.']);
  });

  it("leaves another household's timers and events to that household's agent", async () => {
    await startTimer('pasta');
    await makeDue('pasta');
    const other = await startAgent(servers, await createDemoKitchen());
    try {
      await other.workers.tickScheduler();
      await other.workers.tickEvents();
      await other.workers.drain();
      expect(await timer('pasta')).toMatchObject({ status: 'running' });
      agent.model.push(say('Pasta is ready.'));
      await tick();
      expect((await proactive()).map((m) => m.speech)).toEqual(['Pasta is ready.']);
      expect(other.model.requests).toEqual([]);
    } finally {
      await other.close();
    }
  });

  it('runs the scheduler and worker on their own once started', async () => {
    await startTimer('tea');
    await makeDue('tea');
    agent.model.push(say('Tea is ready.'));
    agent.workers.start();
    for (let i = 0; i < 50 && (await proactive()).length === 0; i++) await wait(100);
    await agent.workers.stop();
    expect((await proactive()).map((m) => m.speech)).toEqual(['Tea is ready.']);
  });
});
