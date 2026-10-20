import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AgentConfig } from './config.ts';
import { connectMcp } from './mcpClient.ts';

export interface HealthReport {
  ok: boolean;
  db: boolean;
  mcp: { ok: boolean; tools: string[] };
  internal: boolean;
}

/** Agent HTTP app. M0: health only; chat, cards and voice routes arrive in M4/M5. */
export async function buildAgentApp(config: AgentConfig, pool: pg.Pool, log = true): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: config.bodyLimitBytes, logger: log ? { level: process.env.LOG_LEVEL ?? 'info' } : false });

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

  return app;
}
