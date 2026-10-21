// The eval harness itself (§9.4), on a scripted model: a case's four checks see what really happened.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningServers, startServers } from '@pantrymos/mcp-server';
import { mcpTestConfig } from '../../../../test/fixtures.ts';
import { CASES } from '../../eval/cases.ts';
import type { Claim } from '../../eval/checks.ts';
import type { ClaimExtractor } from '../../eval/extractor.ts';
import { type EvalCase, passed, runCase, withoutReadBacks } from '../../eval/harness.ts';
import { callTools, ScriptedModel, say } from '../fixtures.ts';

/** Stands in for the LLM extractor: returns the claims given, and records what it was asked. */
class FixedExtractor implements ClaimExtractor {
  asked: string[][] = [];
  private readonly claims: Claim[];
  constructor(claims: Claim[] = []) {
    this.claims = claims;
  }
  async extract(replies: readonly string[]): Promise<Claim[]> {
    this.asked.push([...replies]);
    return this.claims;
  }
}

describe('eval harness', () => {
  let servers: RunningServers;
  beforeAll(async () => {
    servers = await startServers(mcpTestConfig(), { log: false });
  });
  afterAll(async () => servers.close());

  const p3 = CASES.find((c) => c.id === 'P3')!;
  /** P3 as the model should play it: one intake card for 6 eggs. */
  const scriptP3 = () =>
    new ScriptedModel().push(callTools(['propose_intake', { items: [{ name: 'egg', quantity: 6 }] }]), say('Here is a card for your eggs.'));

  it('passes P3 played right: the stale v1 click is refused, the voice "yes" commits the edited v2', async () => {
    const extractor = new FixedExtractor([{ message: 2, item: 'eggs', change: 'added', quantity: 12, unit: null }]);
    const r = await runCase(servers, scriptP3(), extractor, p3);

    expect(r.aborted).toBeNull();
    expect(r.checks).toEqual({
      tools: { verdict: 'pass', notes: [] },
      args: { verdict: 'pass', notes: [] },
      db: { verdict: 'pass', notes: [] },
      reply: { verdict: 'pass', notes: [] },
    });
    expect(passed(r)).toBe(true);
    expect(r.calls).toEqual([{ name: 'propose_intake', input: { items: [{ name: 'egg', quantity: 6 }] }, status: 'success' }]);
    expect(r.turns.map((t) => t.input)).toEqual([
      'I bought 6 eggs',
      '[edits v1: {"items":[{"name":"egg","quantity":12}]}]',
      '[clicks confirm on v1]',
      '🎤 yes',
    ]);
    // The log keeps what was said; the extractor hears it without the cards' read-backs (a card
    // proposes, it claims nothing), the templated gate reply included.
    expect(r.turns[0]!.replies).toEqual(["Here is a card for your eggs. I'll add 6 eggs. Say confirm, or tell me what to change."]);
    expect(r.turns[1]!).toMatchObject({ replies: ["I'll add 12 eggs. Say confirm, or tell me what to change."], claimable: [] });
    expect(extractor.asked).toEqual([['Done — added to your stock.']]); // "Here is a card…" proposes
    expect(r.latency.modelCalls).toBe(2);
  });

  it('fails the reply check when Mos claims an amount that was not committed', async () => {
    const extractor = new FixedExtractor([{ message: 0, item: 'egg', change: 'added', quantity: 6, unit: null }]);
    const r = await runCase(servers, scriptP3(), extractor, p3);
    expect(r.checks.reply).toEqual({ verdict: 'fail', notes: ['reply 0: added 6 egg, but egg +12 count was committed'] });
    expect(passed(r)).toBe(false);
  });

  it('takes each card read-back out of the speech it was appended to', () => {
    const card = (readback_text: string) => ({ type: 'proposal', card: { readback_text } });
    expect(withoutReadBacks({ speech: "Spilled? I'll record 200 ml. Say confirm.", cards: [card("I'll record 200 ml. Say confirm.")] })).toBe('Spilled?');
    expect(withoutReadBacks({ speech: 'Step 2: boil.', cards: [{ type: 'step' }] })).toBe('Step 2: boil.');
    // A sentence that only proposes claims nothing, however it is worded.
    expect(withoutReadBacks({ speech: "I’ll record 4 eggs instead of 3. Saved your milk. It will be added once you say “confirm”.", cards: [] })).toBe(
      'Saved your milk.',
    );
  });

  it('records an aborted script and still checks what happened', async () => {
    const model = new ScriptedModel().push(say('How many eggs did you buy?'));
    const r = await runCase(servers, model, new FixedExtractor(), p3);
    expect(r.aborted).toBe('no proposal card was shown');
    expect(r.checks.tools.notes).toEqual(['expected propose_intake in order; missing propose_intake after call #0 (called: none)']);
    expect(r.checks.db).toEqual({ verdict: 'fail', notes: ['egg: changed by 0, expected 12', 'operations [], expected [intake]'] });
    expect(passed(r)).toBe(false);
  });

  it('files mid-case findings under their check, and reports an extractor failure as unverified', async () => {
    const probe: EvalCase = {
      id: 'T1',
      title: 'probe',
      stock: { egg: 6 },
      async run(ctx) {
        await ctx.say('hello');
        ctx.expect('tools', ctx.lastCalls.length === 1, `expected one call, got ${ctx.lastCalls.length}`);
        ctx.expect('db', (await ctx.session()) !== undefined, 'no cooking session');
      },
      expect: { tools: [], db: { stock: {}, operations: [] } },
    };
    const failing: ClaimExtractor = { extract: async () => Promise.reject(new Error('throttled')) };
    const r = await runCase(servers, new ScriptedModel().push(say('Hi!')), failing, probe);
    expect(r.checks.tools).toEqual({ verdict: 'fail', notes: ['expected one call, got 0'] });
    expect(r.checks.db).toEqual({ verdict: 'fail', notes: ['no cooking session'] });
    expect(r.checks.reply).toEqual({ verdict: 'unverified', notes: ['claim extractor failed: throttled'] });
    expect(r.turns).toEqual([expect.objectContaining({ input: 'hello', replies: ['Hi!'], calls: [] })]);
  });
});
