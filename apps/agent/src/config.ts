import { z } from 'zod';

const ConfigSchema = z.object({
  databaseUrl: z.string().min(1),
  bindHost: z.string().default('127.0.0.1'),
  port: z.coerce.number().int().min(0).max(65535).default(7400),
  mcpUrl: z.url(),
  internalUrl: z.url(),
  mcpToken: z.string().min(16, 'AGENT_MCP_TOKEN must be at least 16 characters'),
  serviceToken: z.string().min(16, 'SERVICE_TOKEN must be at least 16 characters'),
  bodyLimitBytes: z.coerce.number().int().positive().default(64 * 1024),
});

export type AgentConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  return ConfigSchema.parse({
    databaseUrl: env.AGENT_DATABASE_URL,
    bindHost: env.AGENT_BIND_HOST,
    port: env.AGENT_PORT,
    mcpUrl: env.AGENT_MCP_URL,
    internalUrl: env.AGENT_INTERNAL_URL,
    mcpToken: env.AGENT_MCP_TOKEN,
    serviceToken: env.SERVICE_TOKEN,
    bodyLimitBytes: env.AGENT_BODY_LIMIT_BYTES,
  });
}
