import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuth } from './auth.ts';
import type { ChatGPTAccount } from './chatgpt/account.ts';
import { registerModelRoutes } from './chatgpt/routes.ts';
import type { AgentConfig } from './config.ts';
import type { Pool } from './db.ts';
import { InternalClient } from './internalClient.ts';
import { connectMcp } from './mcpClient.ts';
import type { ModelClient } from './model/types.ts';
import { registerRoutes } from './routes.ts';
import type { LeaseTiming } from './store/lease.ts';
import type { TurnDeps } from './turn/runTurn.ts';
import { type WorkerTiming, Workers } from './workers.ts';

export interface HealthReport {
  ok: boolean;
  db: boolean;
  mcp: { ok: boolean; tools: string[] };
  internal: boolean;
}

export interface AgentOptions {
  model: ModelClient;
  /** The ChatGPT sign-in the model runs on, when it runs on a ChatGPT plan. */
  chatgpt?: ChatGPTAccount | null;
  /** How turns reach the MCP server; defaults to the configured URL and token. */
  connectMcp?: TurnDeps['connectMcp'];
  log?: boolean;
  /** Run the timer scheduler and the event worker (off in tests that drive them by hand). */
  workers?: boolean;
  workerTiming?: Partial<WorkerTiming>;
  leaseTiming?: LeaseTiming;
  windowMs?: number;
}

export interface AgentApp {
  app: FastifyInstance;
  workers: Workers;
}

/** The agent backend (§8): chat, voice gate, card actions and the proactive engine. */
export async function buildAgentApp(config: AgentConfig, pool: Pool, options: AgentOptions): Promise<AgentApp> {
  const app = Fastify({
    bodyLimit: config.bodyLimitBytes,
    logger: options.log === false ? false : { level: process.env.LOG_LEVEL ?? 'info' },
  });
  // An idle connection the database closed (a restart, a failover) is replaced on next use;
  // with no listener, its error would end the process.
  pool.on('error', (err) => app.log.warn({ err }, 'idle database connection lost'));
  const internal = new InternalClient(config.internalUrl, config.serviceToken);
  const turn: TurnDeps = {
    pool,
    model: options.model,
    connectMcp: options.connectMcp ?? (() => connectMcp(config.mcpUrl, config.mcpToken)),
  };
  const workers = new Workers(turn, config.householdId, {
    ...(options.workerTiming ? { timing: options.workerTiming } : {}),
    ...(options.leaseTiming ? { leaseTiming: options.leaseTiming } : {}),
    onError: (err, context) => app.log.error({ err }, `${context} failed`),
  });

  // §11.5: per-route limits only (/api/chat); everything else is unlimited here.
  await app.register(rateLimit, { global: false });

  // The agent is the public entry point: a fault is logged, never described to the client.
  app.setErrorHandler((err: { statusCode?: number }, request, reply) => {
    const status = err.statusCode ?? 500;
    if (status < 500) return reply.send(err);
    request.log.error({ err }, 'request failed');
    return reply.code(500).send({ error: 'internal_error', message: 'Something went wrong. Please try again.' });
  });

  registerAuth(app, config);

  app.get('/api/health', async (_request, reply) => {
    const report: HealthReport = { ok: false, db: false, mcp: { ok: false, tools: [] }, internal: false };

    try {
      await pool.query('SELECT 1 FROM agent.conversations LIMIT 0');
      report.db = true;
    } catch (err) {
      app.log.warn({ err }, 'health: database check failed');
    }

    try {
      const client = await connectMcp(config.mcpUrl, config.mcpToken);
      try {
        const { tools } = await client.listTools();
        report.mcp = { ok: true, tools: tools.map((t) => t.name) };
      } finally {
        await client.close();
      }
    } catch (err) {
      app.log.warn({ err }, 'health: MCP check failed');
    }

    try {
      const res = await fetch(new URL('/internal/health', config.internalUrl), {
        headers: { 'x-service-token': config.serviceToken },
      });
      report.internal = res.ok;
    } catch (err) {
      app.log.warn({ err }, 'health: internal API check failed');
    }

    report.ok = report.db && report.mcp.ok && report.internal;
    return reply.code(report.ok ? 200 : 503).send(report);
  });

  registerModelRoutes(app, {
    provider: config.model.provider,
    account: options.chatgpt ?? null,
    returnUrl: (config.model.provider === 'chatgpt' && config.model.returnUrl) || `${config.appOrigins[0]}/`,
  });

  registerRoutes(app, {
    pool,
    config,
    internal,
    turn,
    ...(options.leaseTiming ? { leaseTiming: options.leaseTiming } : {}),
    ...(options.windowMs ? { windowMs: options.windowMs } : {}),
  });

  // The web app, from the same origin as /api (§11.4).
  if (config.webDir) await app.register(fastifyStatic, { root: config.webDir, index: 'index.html' });

  if (options.workers !== false) workers.start();
  app.addHook('onClose', async () => workers.stop());
  return { app, workers };
}
