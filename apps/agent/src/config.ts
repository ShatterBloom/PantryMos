import { z } from 'zod';

const csv = (value: unknown) =>
  typeof value === 'string'
    ? value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : value;

const BedrockSchema = z.object({
  region: z.string().min(1).default('ap-southeast-2'),
  /**
   * An Amazon Nova model or inference profile (Converse API). Nova 2 Lite: in the eval it followed
   * the tool rules far better than Nova Pro. It has no apac profile; global is the one in Sydney.
   */
  modelId: z.string().min(1).default('global.amazon.nova-2-lite-v1:0'),
  maxTokens: z.coerce.number().int().min(64).max(4096).default(1024),
});

/** Any OpenAI-compatible Chat Completions API: OpenAI, or a local server such as Ollama or vLLM. */
const OpenAISchema = z.object({
  baseUrl: z.url().default('https://api.openai.com/v1'),
  /** Local servers usually need none. */
  apiKey: z.string().min(1).optional(),
  model: z.string({ error: 'OPENAI_MODEL is required when MODEL_PROVIDER=openai' }).min(1),
  maxTokens: z.coerce.number().int().min(64).max(4096).default(1024),
  timeoutMs: z.coerce.number().int().positive().default(60_000),
});

/** The model the agent talks to. Bedrock is the one the prompt and guardrails were tuned and evaluated on. */
const ModelSchema = z.discriminatedUnion('provider', [
  BedrockSchema.extend({ provider: z.literal('bedrock') }),
  OpenAISchema.extend({ provider: z.literal('openai') }),
]);

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
  /** The built web app (apps/web/dist) to serve at /; unset in development, where Vite serves it. */
  webDir: z.string().min(1).optional(),
  session: z.object({
    /** Signs the session cookie (§11.4). */
    secret: z.string().min(32, 'AGENT_SESSION_SECRET must be at least 32 characters'),
    /**
     * Unset: anyone who reaches the app is signed in as the demo user, which is safe only while the
     * agent is published to the host's loopback alone (compose). Set it when deployed.
     */
    passcode: z.string().min(6, 'AGENT_PASSCODE must be at least 6 characters').optional(),
    /** Secure cookies need HTTPS; on when deployed behind TLS. */
    secureCookie: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    ttlSeconds: z.coerce.number().int().positive().default(12 * 3600),
  }),
  model: ModelSchema,
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
    webDir: env.AGENT_WEB_DIR || undefined,
    session: {
      secret: env.AGENT_SESSION_SECRET,
      passcode: env.AGENT_PASSCODE || undefined,
      secureCookie: env.AGENT_SECURE_COOKIE,
      ttlSeconds: env.AGENT_SESSION_TTL_SECONDS,
    },
    model: modelEnv(env),
  });
}

const modelEnv = (env: NodeJS.ProcessEnv) =>
  (env.MODEL_PROVIDER || 'bedrock') === 'openai'
    ? {
        provider: 'openai',
        baseUrl: env.OPENAI_BASE_URL || undefined,
        apiKey: env.OPENAI_API_KEY || undefined,
        model: env.OPENAI_MODEL || undefined,
        maxTokens: env.OPENAI_MAX_TOKENS,
        timeoutMs: env.OPENAI_TIMEOUT_MS,
      }
    : { provider: env.MODEL_PROVIDER || 'bedrock', ...bedrockEnv(env) };

const bedrockEnv = (env: NodeJS.ProcessEnv) => ({
  region: env.BEDROCK_REGION ?? env.AWS_REGION,
  modelId: env.BEDROCK_MODEL_ID,
  maxTokens: env.BEDROCK_MAX_TOKENS,
});

/** The model settings alone, from the same variables, for tools that only talk to the model (the eval). */
export function loadModelConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig['model'] {
  return ModelSchema.parse(modelEnv(env));
}

/** Bedrock's settings alone, for the eval's claim extractor, which always runs on Bedrock. */
export function loadBedrockConfig(env: NodeJS.ProcessEnv = process.env): z.infer<typeof BedrockSchema> {
  return BedrockSchema.parse(bedrockEnv(env));
}
