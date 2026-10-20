import { z } from 'zod';

const csv = (value: unknown) =>
  typeof value === 'string'
    ? value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : value;

const ConfigSchema = z.object({
  databaseUrl: z.string().min(1),
  bindHost: z.string().default('127.0.0.1'),
  port: z.coerce.number().int().min(0).max(65535).default(7400),
  mcpUrl: z.url(),
  internalUrl: z.url(),
  mcpToken: z.string().min(16, 'AGENT_MCP_TOKEN must be at least 16 characters'),
  serviceToken: z.string().min(16, 'SERVICE_TOKEN must be at least 16 characters'),
  bodyLimitBytes: z.coerce.number().int().positive().default(64 * 1024),
  /** The household the agent's MCP token belongs to; conversations are recorded under it. */
  householdId: z.uuid('AGENT_HOUSEHOLD_ID must be a UUID'),
  /** Locally a single demo user is signed in (§11.4). */
  userId: z.string().min(1).max(60).default('demo'),
  /** Origins allowed to make state-changing /api requests (§11.4). */
  appOrigins: z.preprocess(csv, z.array(z.url()).min(1)).default(['http://localhost:7400', 'http://127.0.0.1:7400']),
  chatRatePerMinute: z.coerce.number().int().positive().default(30),
  bedrock: z.object({
    region: z.string().min(1).default('ap-southeast-2'),
    /** An Amazon Nova model or inference profile (Converse API). */
    modelId: z.string().min(1).default('apac.amazon.nova-pro-v1:0'),
    maxTokens: z.coerce.number().int().min(64).max(4096).default(1024),
  }),
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
    householdId: env.AGENT_HOUSEHOLD_ID,
    userId: env.AGENT_USER_ID,
    appOrigins: env.AGENT_APP_ORIGINS,
    chatRatePerMinute: env.AGENT_CHAT_RATE_PER_MINUTE,
    bedrock: {
      region: env.BEDROCK_REGION ?? env.AWS_REGION,
      modelId: env.BEDROCK_MODEL_ID,
      maxTokens: env.BEDROCK_MAX_TOKENS,
    },
  });
}
