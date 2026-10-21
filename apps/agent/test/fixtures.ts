// Agent test harness: real mcp-server and Postgres, a scripted model in place of Bedrock (§9.5).
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import type pg from 'pg';
import type { RunningServers } from '@pantrymos/mcp-server';
import { type AgentOptions, buildAgentApp } from '../src/app.ts';
import type { AgentConfig } from '../src/config.ts';
import { createPool } from '../src/db.ts';
import type { ContentBlock, ModelClient, ModelRequest, ModelResponse } from '../src/model/types.ts';
import type { Workers } from '../src/workers.ts';
import { type DemoKitchen, TEST_SERVICE_TOKEN } from '../../../test/fixtures.ts';
import { TEST_AGENT_DB_URL } from '../../../test/env.ts';

export const APP_ORIGIN = 'http://localhost:7400';
export const TEST_SESSION_SECRET = 'test-session-secret-0123456789abcdef';

/** One scripted model reply: fixed, or computed from the request (to read tool results). */
export type Step = ModelResponse | ((request: ModelRequest) => ModelResponse | Promise<ModelResponse>);

/**
 * Stands in for Bedrock: replies with the next scripted step and records every request. Running
 * out of script is a test failure, which is how "zero model calls" is checked.
 */
export class ScriptedModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  private readonly script: Step[] = [];

  push(...steps: Step[]): this {
    this.script.push(...steps);
    return this;
  }

  get remaining(): number {
    return this.script.length;
  }

  async converse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(request));
    const step = this.script.shift();
    if (!step) throw new Error(`Unscripted model call (#${this.requests.length})`);
    return typeof step === 'function' ? step(request) : step;
  }
}

let toolUseSeq = 0;

/** The model asks for tools, in order. */
export const callTools = (...calls: Array<[name: string, input?: Record<string, unknown>]>): ModelResponse => ({
  stopReason: 'tool_use',
  content: calls.map(([name, input]) => ({ toolUse: { toolUseId: `tooluse_${++toolUseSeq}`, name, input: input ?? {} } })),
});

/** The model answers. */
export const say = (text: string): ModelResponse => ({ stopReason: 'end_turn', content: [{ text }] });

/** The latest tool results the model was sent, by tool name order. */
export function lastToolResults(request: ModelRequest): Array<Record<string, unknown>> {
  const last = request.messages.at(-1)!;
  return last.content
    .filter((b): b is Extract<ContentBlock, { toolResult: unknown }> => 'toolResult' in b)
    .map((b) => (b.toolResult.content[0] as { json: Record<string, unknown> }).json);
}

export function agentTestConfig(
  servers: RunningServers,
  kitchen: Pick<DemoKitchen, 'householdId' | 'token'>,
  overrides: Partial<AgentConfig> = {}): AgentConfig {
  const mcp = servers.mcp.server.address() as AddressInfo;
  const internal = servers.internal.server.address() as AddressInfo;
  return {
    databaseUrl: TEST_AGENT_DB_URL,
    bindHost: '127.0.0.1',
    port: 0,
    mcpUrl: `http://127.0.0.1:${mcp.port}/mcp`,
    internalUrl: `http://127.0.0.1:${internal.port}`,
    mcpToken: kitchen.token,
    serviceToken: TEST_SERVICE_TOKEN,
    bodyLimitBytes: 64 * 1024,
    householdId: kitchen.householdId,
    userId: 'demo',
    appOrigins: [APP_ORIGIN],
    chatRatePerMinute: 1000,
    session: { secret: TEST_SESSION_SECRET, secureCookie: false, ttlSeconds: 3600 },
    bedrock: { region: 'ap-southeast-2', modelId: 'test', maxTokens: 512 },
    ...overrides,
  };
}

export interface TestAgent<M extends ModelClient = ScriptedModel> {
  app: FastifyInstance;
  workers: Workers;
  pool: pg.Pool;
  model: M;
  conversationId: string;
  /** The signed-in session's Cookie header. */
  cookie: string;
  /** A request as the signed-in web app makes it: from the app origin, with the session cookie. */
  api(options: InjectOptions): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

/** Signs in (§11.4) and returns the Cookie header to send. */
export async function signIn(app: FastifyInstance, passcode?: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/session',
    headers: { origin: APP_ORIGIN },
    payload: passcode === undefined ? {} : { passcode },
  });
  if (res.statusCode !== 200) throw new Error(`sign-in failed: ${res.statusCode} ${res.body}`);
  return String(res.headers['set-cookie']).split(';')[0]!;
}

export type StartOptions = Partial<Omit<AgentOptions, 'model'>> & { config?: Partial<AgentConfig> };

export function startAgent(servers: RunningServers, kitchen: Pick<DemoKitchen, 'householdId' | 'token'>, options: StartOptions = {}): Promise<TestAgent> {
  return startAgentWith(new ScriptedModel(), servers, kitchen, options);
}

/** An agent on the given model: the scripted one, or the real one for the eval (§9.4). */
export async function startAgentWith<M extends ModelClient>(
  model: M,
  servers: RunningServers,
  kitchen: Pick<DemoKitchen, 'householdId' | 'token'>,
  options: StartOptions = {},
): Promise<TestAgent<M>> {
  const { config, ...rest } = options;
  const pool = createPool(config?.databaseUrl ?? TEST_AGENT_DB_URL);
  const { app, workers } = await buildAgentApp(agentTestConfig(servers, kitchen, config), pool, {
    model,
    log: false,
    workers: false,
    ...rest,
  });
  const cookie = await signIn(app, config?.session?.passcode);
  return {
    app,
    workers,
    pool,
    model,
    conversationId: randomUUID(),
    cookie,
    api: (opts) => app.inject({ ...opts, headers: { origin: APP_ORIGIN, cookie, ...opts.headers } }),
    async close() {
      await app.close();
      await pool.end();
    },
  };
}

export interface ChatReply {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, unknown>;
}

/** POST /api/chat from the app's origin. */
export async function chat(
  agent: TestAgent<ModelClient>,
  text: string,
  options: { inputMode?: 'voice' | 'text'; requestId?: string; conversationId?: string } = {},
): Promise<ChatReply> {
  const res = await agent.api({
    method: 'POST',
    url: '/api/chat',
    payload: {
      conversation_id: options.conversationId ?? agent.conversationId,
      request_id: options.requestId ?? randomUUID(),
      text,
      input_mode: options.inputMode ?? 'text',
    },
  });
  return { status: res.statusCode, body: res.json(), headers: res.headers };
}

export const voice = (agent: TestAgent<ModelClient>, text: string, requestId?: string) =>
  chat(agent, text, { inputMode: 'voice', ...(requestId ? { requestId } : {}) });

export interface Outbound {
  id: number;
  turn_type: 'user' | 'proactive' | 'gate';
  speech: string;
  cards: Array<Record<string, unknown>>;
  voice_prompt: Record<string, unknown> | null;
  session_id: string | null;
  step_no: number | null;
}

export async function messages(agent: TestAgent<ModelClient>, after = 0): Promise<Outbound[]> {
  const res = await agent.api({ method: 'GET', url: `/api/messages?conversation_id=${agent.conversationId}&after=${after}` });
  return (res.json() as { messages: Outbound[] }).messages;
}

export async function lastMessage(agent: TestAgent<ModelClient>): Promise<Outbound> {
  return (await messages(agent)).at(-1)!;
}

/** The web app's ack once it finished speaking a message (§8.5). */
export async function ack(agent: TestAgent<ModelClient>, messageId: number, conversationId = agent.conversationId) {
  const res = await agent.api({
    method: 'POST',
    url: '/api/voice-windows/ack',
    payload: { conversation_id: conversationId, message_id: messageId, request_id: randomUUID() },
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

/** A card button click, through the agent (§8.8). */
export async function cardAction(
  agent: TestAgent<ModelClient>,
  method: 'POST' | 'PATCH',
  path: string,
  payload: Record<string, unknown>,
) {
  const res = await agent.api({ method, url: path, payload: { request_id: randomUUID(), ...payload } });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

/**
 * Makes the next statement matching `pattern` on this pool fail, as if the process died there: the
 * transaction rolls back and the request fails, so a retry has to resume.
 */
export function crashOnce(pool: pg.Pool, pattern: RegExp): { fired: () => boolean } {
  let armed = true;
  const patched = new WeakSet<pg.PoolClient>();
  pool.on('acquire', (client) => {
    if (patched.has(client)) return;
    patched.add(client);
    const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
    (client as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = (...args: unknown[]) => {
      const sql = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string } | undefined)?.text;
      if (armed && sql !== undefined && pattern.test(sql)) {
        armed = false;
        return Promise.reject(new Error('injected crash'));
      }
      return query(...args);
    };
  });
  return { fired: () => !armed };
}

/** Runs agent-side SQL as the agent role (no pantry access). */
export async function agentRows<T extends pg.QueryResultRow>(agent: TestAgent<ModelClient>, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await agent.pool.query<T>(sql, params)).rows;
}
