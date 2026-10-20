import { z } from 'zod';

const csv = z
  .string()
  .default('')
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean));

// Both listeners must stay on loopback (IMPLEMENTATION_PLAN §11.1); the agent reaches them
// through the shared network namespace, never over a routable address.
const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'];

const ConfigSchema = z.object({
  databaseUrl: z.string().min(1),
  bindHost: z
    .string()
    .default('127.0.0.1')
    .refine((host) => LOOPBACK_HOSTS.includes(host), 'MCP_BIND_HOST must be a loopback address'),
  mcpPort: z.coerce.number().int().min(0).max(65535).default(7410),
  internalPort: z.coerce.number().int().min(0).max(65535).default(7411),
  serviceToken: z.string().min(16, 'SERVICE_TOKEN must be at least 16 characters'),
  allowedOrigins: csv,
  allowAnonWrites: z.boolean().default(false),
  bodyLimitBytes: z.coerce.number().int().positive().default(64 * 1024),
  mcpRatePerMinute: z.coerce.number().int().positive().default(120),
  internalRatePerMinute: z.coerce.number().int().positive().default(300),
  confirmRatePerMinute: z.coerce.number().int().positive().default(30),
  proposeRatePerMinute: z.coerce.number().int().positive().default(30),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse({
    databaseUrl: env.MCP_DATABASE_URL,
    bindHost: env.MCP_BIND_HOST,
    mcpPort: env.MCP_PORT,
    internalPort: env.INTERNAL_PORT,
    serviceToken: env.SERVICE_TOKEN,
    allowedOrigins: env.MCP_ALLOWED_ORIGINS,
    allowAnonWrites: env.ALLOW_ANON_WRITES === '1',
    bodyLimitBytes: env.MCP_BODY_LIMIT_BYTES,
    mcpRatePerMinute: env.MCP_RATE_PER_MINUTE,
    internalRatePerMinute: env.INTERNAL_RATE_PER_MINUTE,
    confirmRatePerMinute: env.CONFIRM_RATE_PER_MINUTE,
    proposeRatePerMinute: env.PROPOSE_RATE_PER_MINUTE,
  });
}
