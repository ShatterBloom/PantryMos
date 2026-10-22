import rateLimit from '@fastify/rate-limit';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Config } from './config.ts';
import { createPool, type Pool } from './db/pool.ts';
import { registerInternalRoutes } from './internal/routes.ts';
import { buildMcpServer } from './mcp/server.ts';
import { FixedWindowLimiter } from './security/rateLimit.ts';
import {
  type AuthContext,
  bearerToken,
  originAllowed,
  resolveClient,
  serviceTokenMatches,
} from './security/auth.ts';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

const loggerOptions = (enabled: boolean) =>
  enabled ? { level: process.env.LOG_LEVEL ?? 'info' } : false;

/** A fault is logged, never described to the client: its message can name tables or queries. */
function hideFaults(app: FastifyInstance): void {
  app.setErrorHandler((err: { statusCode?: number }, request, reply) => {
    const status = err.statusCode ?? 500;
    if (status < 500) return reply.send(err);
    request.log.error({ err }, 'request failed');
    return reply.code(500).send({ error: 'internal_error' });
  });
}

/**
 * Public-facing MCP listener (§11.1). Only POST /mcp exists; internal routes live on a
 * separate listener, so they are unreachable here by construction.
 */
export async function buildMcpApp(config: Config, pool: Pool, log = true): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: config.bodyLimitBytes, logger: loggerOptions(log) });
  const proposeLimiter = new FixedWindowLimiter(config.proposeRatePerMinute, 60_000);
  hideFaults(app);

  app.addHook('onRequest', async (request, reply) => {
    if (!originAllowed(request.headers.origin, config.allowedOrigins)) {
      return reply.code(403).send({ error: 'forbidden_origin' });
    }
  });

  await app.register(rateLimit, {
    max: config.mcpRatePerMinute,
    timeWindow: '1 minute',
    hook: 'preHandler',
    keyGenerator: (request) => request.auth?.clientId ?? request.ip,
  });

  const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
    const token = bearerToken(request.headers.authorization);
    const auth = token ? await resolveClient(pool, token) : null;
    if (!auth) return reply.code(401).send({ error: 'unauthorized' });
    request.auth = auth;
  };

  app.post('/mcp', { onRequest: authenticate }, async (request, reply) => {
    const auth = request.auth as AuthContext;
    const server = buildMcpServer({ pool, auth, config, proposeLimiter });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  // Stateless server: no SSE stream (GET) and no session termination (DELETE).
  for (const method of ['GET', 'DELETE'] as const) {
    app.route({
      method,
      url: '/mcp',
      onRequest: authenticate,
      handler: async (_request, reply) => reply.code(405).header('allow', 'POST').send({ error: 'method_not_allowed' }),
    });
  }

  return app;
}

/** Internal listener (§11.1, §11.3): never exposed; every route requires the service token. */
export async function buildInternalApp(config: Config, pool: Pool, log = true): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: config.bodyLimitBytes, logger: loggerOptions(log) });
  hideFaults(app);

  app.addHook('onRequest', async (request, reply) => {
    const provided = request.headers['x-service-token'];
    if (!serviceTokenMatches(config.serviceToken, typeof provided === 'string' ? provided : undefined)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  await app.register(rateLimit, { max: config.internalRatePerMinute, timeWindow: '1 minute' });

  app.get('/internal/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true };
  });

  registerInternalRoutes(app, pool, config);

  return app;
}

export interface RunningServers {
  mcp: FastifyInstance;
  internal: FastifyInstance;
  pool: Pool;
  close(): Promise<void>;
}

export async function startServers(config: Config, options: { log?: boolean } = {}): Promise<RunningServers> {
  const pool = createPool(config.databaseUrl);
  const log = options.log ?? true;
  const mcp = await buildMcpApp(config, pool, log);
  const internal = await buildInternalApp(config, pool, log);
  const close = async () => {
    await Promise.allSettled([mcp.close(), internal.close()]);
    await pool.end();
  };
  try {
    await mcp.listen({ host: config.bindHost, port: config.mcpPort });
    await internal.listen({ host: config.bindHost, port: config.internalPort });
  } catch (err) {
    await close();
    throw err;
  }
  return { mcp, internal, pool, close };
}
