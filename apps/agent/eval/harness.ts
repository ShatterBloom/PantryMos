// Runs one eval case against the full stack (IMPLEMENTATION_PLAN §9.4): real mcp-server, Postgres and
// agent, the model given (real Bedrock for the eval, a scripted one for the harness's own test).
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { RunningServers } from '@pantrymos/mcp-server';
import { connectMcpClient, createDemoKitchen, type DemoKitchen, stockKitchen, withAdmin } from '../../../test/fixtures.ts';
import type { ModelClient } from '../src/model/types.ts';
import { DEFAULT_WORKER_TIMING } from '../src/workers.ts';
import { ack, cardAction, chat, messages, type Outbound, startAgentWith, type TestAgent } from '../test/fixtures.ts';
import {
  type ArgExpectation,
  type CheckResult,
  type Claim,
  checkArgs,
  checkClaims,
  checkDb,
  checkTools,
  type CommittedOp,
  type DbExpectation,
  setToOf,
  type StockRow,
  stockDiff,
  type ToolCall,
} from './checks.ts';
import type { ClaimExtractor } from './extractor.ts';
import { type Exchange, RecordingModel, toolCalls } from './recording.ts';

export interface EvalCase {
  /** P1–P9 for the §9.4 priority cases, G1–G12 for §9.6. */
  id: string;
  title: string;
  /** Stock in base units, one batch each, bought yesterday; or a custom setup (before the snapshot). */
  stock?: Record<string, number> | ((env: SetupEnv) => Promise<void>);
  run(ctx: CaseContext): Promise<void>;
  expect: {
    tools: readonly string[];
    forbid?: readonly string[];
    args?: readonly ArgExpectation[];
    db: DbExpectation;
  };
}

export interface ProposalCard {
  proposal_id: string;
  version: number;
  kind: string;
  card: { title: string; lines: string[]; readback_text: string };
}

export interface SetupEnv {
  kitchen: DemoKitchen;
  servers: RunningServers;
  /** An MCP client of the same household, for history made "on another device". */
  mcp: Client;
}

/** A script step could not go on, e.g. the model never produced the card to click. */
export class CaseAborted extends Error {}

export interface Turn {
  /** What the user did: said, clicked, or what happened around them. */
  input: string;
  /** What Mos said in response, in order (proactive messages included). */
  replies: string[];
  /**
   * The same without the read-backs of the cards shown: the app appends those, and a card
   * proposes a change, it does not claim one. This is what the reply check reads.
   */
  claimable: string[];
  /** The tool calls the model made meanwhile. */
  calls: ToolCall[];
  ms: number;
}

/** What a case found mid-run, filed under the check it belongs to. */
export interface Findings {
  tools: string[];
  db: string[];
}

/** What a case script can do: everything a user or the world around them can. */
export class CaseContext {
  readonly turns: Turn[] = [];
  readonly findings: Findings = { tools: [], db: [] };
  readonly agent: TestAgent<RecordingModel>;
  readonly env: SetupEnv;
  private seen = 0;

  constructor(agent: TestAgent<RecordingModel>, env: SetupEnv) {
    this.agent = agent;
    this.env = env;
  }

  /** Typed (or, with `voice`, spoken) input; returns what Mos answered. */
  async say(text: string, mode: 'text' | 'voice' = 'text'): Promise<Outbound[]> {
    return this.record(mode === 'voice' ? `🎤 ${text}` : text, async () => {
      const res = await chat(this.agent, text, { inputMode: mode });
      if (res.status !== 200) throw new CaseAborted(`chat "${text}" → ${res.status} ${JSON.stringify(res.body)}`);
    });
  }

  /** The hands-free loop: the last message was spoken in full (ack), then the user speaks. */
  async answer(phrase: string): Promise<Outbound[]> {
    await this.heard();
    return this.say(phrase, 'voice');
  }

  /** Acks the last message, as the app does once it finished speaking it. */
  async heard(): Promise<void> {
    const last = (await messages(this.agent)).at(-1);
    if (last?.voice_prompt) await ack(this.agent, last.id);
  }

  /** The latest proposal card shown. */
  async card(): Promise<ProposalCard> {
    const card = (await messages(this.agent))
      .flatMap((m) => m.cards)
      .filter((c) => c.type === 'proposal')
      .at(-1) as ProposalCard | undefined;
    if (!card) throw new CaseAborted('no proposal card was shown');
    return card;
  }

  /** A card button. `version` defaults to the card's own, as a click on it sends. */
  async click(action: 'confirm' | 'reject', card?: ProposalCard, version?: number): Promise<{ status: number; body: Record<string, unknown> }> {
    const c = card ?? (await this.card());
    let res!: { status: number; body: Record<string, unknown> };
    await this.record(`[clicks ${action} on v${version ?? c.version}]`, async () => {
      res = await cardAction(this.agent, 'POST', `/api/proposals/${c.proposal_id}/${action}`, { version: version ?? c.version });
    });
    return res;
  }

  /** The card's edit form. */
  async edit(changes: Record<string, unknown>, card?: ProposalCard): Promise<{ status: number; body: Record<string, unknown> }> {
    const c = card ?? (await this.card());
    let res!: { status: number; body: Record<string, unknown> };
    await this.record(`[edits v${c.version}: ${JSON.stringify(changes)}]`, async () => {
      res = await cardAction(this.agent, 'PATCH', `/api/proposals/${c.proposal_id}`, { base_version: c.version, changes });
    });
    return res;
  }

  /** Every running timer is due now; the proactive turns run. */
  async fireTimers(): Promise<Outbound[]> {
    return this.record('[timers fire]', async () => {
      await this.agent.pool.query(`UPDATE agent.timers SET fires_at = now() WHERE conversation_id = $1 AND status = 'running'`, [
        this.agent.conversationId,
      ]);
    });
  }

  /** Something outside the conversation; then any proactive turn it caused runs. */
  async meanwhile(what: string, fn: () => Promise<unknown>): Promise<Outbound[]> {
    return this.record(`[${what}]`, fn);
  }

  /** Notes a failed expectation of the case, under `check`, when `ok` is false. */
  expect(check: keyof Findings, ok: boolean, note: string): void {
    if (!ok) this.findings[check].push(note);
  }

  /** The tool calls of the last user action. */
  get lastCalls(): ToolCall[] {
    return this.turns.at(-1)?.calls ?? [];
  }

  /** The household's cooking session, if one is active. */
  async session(): Promise<{ state: string; current_step: number } | undefined> {
    return withAdmin(async (admin) => {
      const { rows } = await admin.query<{ state: string; current_step: number }>(
        `SELECT state, current_step FROM pantry.cooking_sessions WHERE household_id = $1 ORDER BY started_at DESC LIMIT 1`,
        [this.env.kitchen.householdId],
      );
      return rows[0];
    });
  }

  /** Runs `act`, then the background work it set off, and keeps the messages and calls that followed. */
  private async record(input: string, act: () => Promise<unknown>): Promise<Outbound[]> {
    const started = performance.now();
    const exchanges = this.agent.model.exchanges.length;
    await act();
    await this.settle();
    const fresh = (await messages(this.agent)).filter((m) => m.id > this.seen);
    this.seen = Math.max(this.seen, ...fresh.map((m) => m.id));
    this.turns.push({
      input,
      replies: fresh.map((m) => m.speech),
      claimable: fresh.map(withoutReadBacks).filter((s) => s !== ''),
      calls: toolCalls(this.agent.model.exchanges.slice(exchanges)),
      ms: performance.now() - started,
    });
    return fresh;
  }

  /** Scheduler and event passes until nothing is left to run (bounded). */
  private async settle(): Promise<void> {
    for (let i = 0; i < 5; i++) {
      await this.agent.workers.tickScheduler();
      await this.agent.workers.tickEvents();
      await this.agent.workers.drain();
      const { rows } = await this.agent.pool.query(
        `SELECT 1 FROM agent.app_events WHERE conversation_id = $1 AND triggers_turn AND turn_done_at IS NULL AND NOT turn_failed`,
        [this.agent.conversationId],
      );
      if (rows.length === 0) return;
    }
  }
}

export interface CaseResult {
  id: string;
  title: string;
  checks: { tools: CheckResult; args: CheckResult; db: CheckResult; reply: CheckResult };
  /** Set when the script could not finish; the checks still ran on what happened. */
  aborted: string | null;
  turns: Turn[];
  calls: ToolCall[];
  claims: Claim[];
  /** Every model request and response, for the raw dump. */
  exchanges: Exchange[];
  latency: { modelCalls: number; modelMs: number; totalMs: number };
  /** Tokens the agent's model calls used (the extractor's are not counted). */
  tokens: { input: number; output: number };
}

export const passed = (r: CaseResult) => r.aborted === null && Object.values(r.checks).every((c) => c.verdict === 'pass');

/** A message's speech less the read-back text of each card it carries. */
export function withoutReadBacks(m: Pick<Outbound, 'speech' | 'cards'>): string {
  let speech = m.speech;
  for (const c of m.cards) {
    const readBack = (c.card as { readback_text?: string } | undefined)?.readback_text;
    if (readBack) speech = speech.replace(readBack, '');
  }
  return speech.replace(/\s+/g, ' ').trim();
}

/** Worker timing for the eval: no gap between proactive turns, so a case never waits on a clock. */
const EVAL_TIMING = { ...DEFAULT_WORKER_TIMING, proactiveGapMs: 0 };

export async function runCase(servers: RunningServers, model: ModelClient, extractor: ClaimExtractor, c: EvalCase): Promise<CaseResult> {
  const kitchen = await createDemoKitchen();
  const mcp = await connectMcpClient(servers, kitchen.token);
  const env = { kitchen, servers, mcp };
  if (typeof c.stock === 'function') await c.stock(env);
  else if (c.stock) await stockKitchen(kitchen, c.stock);

  const before = await snapshot(kitchen.householdId);
  const agent = await startAgentWith(new RecordingModel(model), servers, kitchen, { workerTiming: EVAL_TIMING });
  const ctx = new CaseContext(agent, env);
  let aborted: string | null = null;
  try {
    await c.run(ctx);
  } catch (err) {
    aborted = err instanceof CaseAborted ? err.message : `error: ${(err as Error).stack ?? String(err)}`;
  } finally {
    await mcp.close();
    await agent.close();
  }

  const after = await snapshot(kitchen.householdId);
  const committed = after.operations.slice(before.operations.length);
  const kinds = committed.map((o) => o.kind);
  const diff = stockDiff(before.stock, after.stock);
  const calls = toolCalls(agent.model.exchanges);
  const withFindings = (check: CheckResult, notes: string[]): CheckResult =>
    notes.length === 0 ? check : { verdict: 'fail', notes: [...check.notes, ...notes] };
  const replies = ctx.turns.flatMap((t) => t.claimable);
  let claims: Claim[] = [];
  let reply: CheckResult;
  try {
    claims = await extractor.extract(replies);
    reply = checkClaims(claims, committed, diff);
  } catch (err) {
    reply = { verdict: 'unverified', notes: [`claim extractor failed: ${(err as Error).message}`] };
  }

  return {
    id: c.id,
    title: c.title,
    checks: {
      tools: withFindings(checkTools(calls, c.expect.tools, c.expect.forbid), ctx.findings.tools),
      args: checkArgs(calls, c.expect.args ?? []),
      db: withFindings(checkDb(diff, kinds, c.expect.db), ctx.findings.db),
      reply,
    },
    aborted,
    turns: ctx.turns,
    calls,
    claims,
    exchanges: agent.model.exchanges,
    latency: {
      modelCalls: agent.model.exchanges.length,
      modelMs: Math.round(agent.model.exchanges.reduce((s, e) => s + e.ms, 0)),
      totalMs: Math.round(ctx.turns.reduce((s, t) => s + t.ms, 0)),
    },
    tokens: {
      input: agent.model.exchanges.reduce((s, e) => s + (e.response.usage?.inputTokens ?? 0), 0),
      output: agent.model.exchanges.reduce((s, e) => s + (e.response.usage?.outputTokens ?? 0), 0),
    },
  };
}

/** The household's stock per item, and its operations in commit order with what each changed. */
async function snapshot(householdId: string): Promise<{ stock: StockRow[]; operations: CommittedOp[] }> {
  return withAdmin(async (admin) => {
    const stock = await admin.query<StockRow>(
      `SELECT i.name AS item, i.base_unit AS unit, COALESCE(sum(b.quantity), 0)::float AS quantity
         FROM pantry.items i LEFT JOIN pantry.batches b ON b.item_id = i.id
        WHERE i.household_id = $1 GROUP BY i.name, i.base_unit`,
      [householdId],
    );
    const ops = await admin.query<{ id: string; kind: string; summary: Record<string, unknown> }>(
      `SELECT id, kind, summary FROM pantry.operations WHERE household_id = $1 ORDER BY created_at, id`,
      [householdId],
    );
    const events = await admin.query<{ operation_id: string; item: string; unit: string; delta: number }>(
      `SELECT e.operation_id, i.name AS item, i.base_unit AS unit, sum(e.delta)::float AS delta
         FROM pantry.inventory_events e JOIN pantry.items i ON i.id = e.item_id
        WHERE i.household_id = $1 GROUP BY e.operation_id, i.name, i.base_unit HAVING sum(e.delta) <> 0`,
      [householdId],
    );
    return {
      stock: stock.rows,
      operations: ops.rows.map((o) => ({
        kind: o.kind,
        changes: new Map(events.rows.filter((e) => e.operation_id === o.id).map((e) => [e.item, { delta: e.delta, unit: e.unit }])),
        setTo: setToOf(o.kind, o.summary),
      })),
    };
  });
}
