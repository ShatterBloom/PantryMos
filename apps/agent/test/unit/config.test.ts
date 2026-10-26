import { describe, expect, it } from 'vitest';
import { loadConfig, loadModelConfig } from '../../src/config.ts';

const REQUIRED = {
  AGENT_DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
  AGENT_MCP_URL: 'http://127.0.0.1:7410/mcp',
  AGENT_INTERNAL_URL: 'http://127.0.0.1:7411',
  AGENT_MCP_TOKEN: 'agent-mcp-token-0123456789',
  SERVICE_TOKEN: 'service-token-0123456789',
  AGENT_HOUSEHOLD_ID: '00000000-0000-4000-8000-000000000001',
  AGENT_SESSION_SECRET: 'session-secret-0123456789abcdefghij',
  MODEL_PROVIDERS: 'bedrock',
};
const KEY = 'chatgpt-token-key-for-tests-0123456789';

describe('agent loadConfig', () => {
  it('applies the documented defaults', () => {
    expect(loadConfig(REQUIRED)).toEqual({
      databaseUrl: REQUIRED.AGENT_DATABASE_URL,
      bindHost: '127.0.0.1',
      port: 7400,
      mcpUrl: REQUIRED.AGENT_MCP_URL,
      internalUrl: REQUIRED.AGENT_INTERNAL_URL,
      mcpToken: REQUIRED.AGENT_MCP_TOKEN,
      serviceToken: REQUIRED.SERVICE_TOKEN,
      bodyLimitBytes: 64 * 1024,
      householdId: REQUIRED.AGENT_HOUSEHOLD_ID,
      userId: 'demo',
      appOrigins: ['http://localhost:7400', 'http://127.0.0.1:7400'],
      chatRatePerMinute: 30,
      session: { secret: REQUIRED.AGENT_SESSION_SECRET, secureCookie: false, ttlSeconds: 43_200 },
      models: [{ provider: 'bedrock', region: 'ap-southeast-2', modelId: 'global.amazon.nova-2-lite-v1:0', maxTokens: 1024 }],
    });
  });

  it('parses the bind host, port, body limit, origins and model settings', () => {
    expect(
      loadConfig({
        ...REQUIRED,
        AGENT_BIND_HOST: '0.0.0.0',
        AGENT_PORT: '9000',
        AGENT_BODY_LIMIT_BYTES: '2048',
        AGENT_APP_ORIGINS: 'http://localhost:5173, http://localhost:7400',
        AWS_REGION: 'us-east-1',
        BEDROCK_MODEL_ID: 'amazon.nova-lite-v1:0',
        BEDROCK_MAX_TOKENS: '512',
      }),
    ).toMatchObject({
      bindHost: '0.0.0.0',
      port: 9000,
      bodyLimitBytes: 2048,
      appOrigins: ['http://localhost:5173', 'http://localhost:7400'],
      models: [{ provider: 'bedrock', region: 'us-east-1', modelId: 'amazon.nova-lite-v1:0', maxTokens: 512 }],
    });
    expect(loadConfig({ ...REQUIRED, AWS_REGION: 'us-east-1', BEDROCK_REGION: 'us-west-2' }).models[0]).toMatchObject({ region: 'us-west-2' });
  });

  it('offers every provider MODEL_PROVIDERS names, and needs at least one', () => {
    const all = loadConfig({ ...REQUIRED, MODEL_PROVIDERS: 'chatgpt, openai,bedrock,openai', OPENAI_MODEL: 'gpt-4.1-mini', CHATGPT_TOKEN_KEY: KEY });
    expect(all.models.map((m) => m.provider)).toEqual(['chatgpt', 'openai', 'bedrock']);
    expect(() => loadConfig({ ...REQUIRED, MODEL_PROVIDERS: undefined })).toThrow(/MODEL_PROVIDERS must name at least one/);
    expect(() => loadConfig({ ...REQUIRED, MODEL_PROVIDERS: ' , ' })).toThrow(/MODEL_PROVIDERS must name at least one/);
    expect(() => loadConfig({ ...REQUIRED, MODEL_PROVIDERS: 'bedrock,gemini' })).toThrow();
    // Each one named is checked in full, not only the one in use.
    expect(() => loadConfig({ ...REQUIRED, MODEL_PROVIDERS: 'bedrock,openai' })).toThrow(/OPENAI_MODEL is required when MODEL_PROVIDERS includes openai/);
  });

  it('loads one provider alone for the eval', () => {
    expect(loadModelConfig('openai', { OPENAI_MODEL: 'gpt-4.1-mini' })).toMatchObject({ provider: 'openai', model: 'gpt-4.1-mini' });
    expect(loadModelConfig('bedrock', {})).toMatchObject({ provider: 'bedrock', modelId: 'global.amazon.nova-2-lite-v1:0' });
    expect(() => loadModelConfig('gemini', {})).toThrow();
  });

  it('configures an OpenAI-compatible model with MODEL_PROVIDERS=openai', () => {
    expect(loadConfig({ ...REQUIRED, MODEL_PROVIDERS: 'openai', OPENAI_MODEL: 'gpt-4.1-mini', OPENAI_API_KEY: 'sk-test' }).models[0]).toEqual({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4.1-mini',
      maxTokens: 1024,
      timeoutMs: 60_000,
    });
    // A local server: its own URL, no key (compose passes an empty one).
    expect(
      loadConfig({ ...REQUIRED, MODEL_PROVIDERS: 'openai', OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1', OPENAI_MODEL: 'qwen3:8b', OPENAI_API_KEY: '', OPENAI_MAX_TOKENS: '2048' }).models[0],
    ).toEqual({ provider: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b', maxTokens: 2048, timeoutMs: 60_000 });
    expect(() => loadConfig({ ...REQUIRED, MODEL_PROVIDERS: 'openai' })).toThrow(/OPENAI_MODEL/);
    expect(() => loadConfig({ ...REQUIRED, MODEL_PROVIDERS: 'gemini' })).toThrow();
  });

  it('configures a ChatGPT plan with MODEL_PROVIDERS=chatgpt, its callback on the agent port', () => {
    expect(loadConfig({ ...REQUIRED, MODEL_PROVIDERS: 'chatgpt', CHATGPT_TOKEN_KEY: KEY }).models[0]).toEqual({
      provider: 'chatgpt',
      tokenKey: KEY,
      callbackUrl: 'http://127.0.0.1:7400/auth/chatgpt/callback',
      authUrl: 'https://auth.openai.com',
      apiUrl: 'https://api.openai.com/v1',
      maxTokens: 1024,
      timeoutMs: 120_000,
    });
    // Only the port can change: the agent's, or the published one when docker maps it elsewhere.
    expect(loadConfig({ ...REQUIRED, MODEL_PROVIDERS: 'chatgpt', CHATGPT_TOKEN_KEY: KEY, AGENT_PORT: '9000' }).models[0]).toMatchObject({ callbackUrl: 'http://127.0.0.1:9000/auth/chatgpt/callback' });
    expect(
      loadConfig({ ...REQUIRED, MODEL_PROVIDERS: 'chatgpt', CHATGPT_TOKEN_KEY: KEY, AGENT_PORT: '7400', CHATGPT_CALLBACK_PORT: '8400', CHATGPT_MODEL: 'gpt-x', CHATGPT_RETURN_URL: 'http://localhost:5173/' }).models[0],
    ).toMatchObject({ callbackUrl: 'http://127.0.0.1:8400/auth/chatgpt/callback', model: 'gpt-x', returnUrl: 'http://localhost:5173/' });
    expect(() => loadConfig({ ...REQUIRED, MODEL_PROVIDERS: 'chatgpt', CHATGPT_TOKEN_KEY: KEY, CHATGPT_CALLBACK_PORT: 'x' })).toThrow();
    // The tokens are encrypted under a key of its own.
    expect(() => loadConfig({ ...REQUIRED, MODEL_PROVIDERS: 'chatgpt' })).toThrow(/CHATGPT_TOKEN_KEY is required/);
    expect(() => loadConfig({ ...REQUIRED, MODEL_PROVIDERS: 'chatgpt', CHATGPT_TOKEN_KEY: 'short' })).toThrow(/CHATGPT_TOKEN_KEY must be/);
  });

  it('rejects malformed URLs, short tokens and a missing household', () => {
    expect(() => loadConfig({ ...REQUIRED, AGENT_MCP_URL: 'not a url' })).toThrow();
    expect(() => loadConfig({ ...REQUIRED, AGENT_MCP_TOKEN: 'short' })).toThrow(/AGENT_MCP_TOKEN/);
    expect(() => loadConfig({ ...REQUIRED, SERVICE_TOKEN: 'short' })).toThrow(/SERVICE_TOKEN/);
    expect(() => loadConfig({ ...REQUIRED, AGENT_HOUSEHOLD_ID: undefined })).toThrow(/AGENT_HOUSEHOLD_ID/);
    expect(() => loadConfig({ ...REQUIRED, AGENT_APP_ORIGINS: 'not-an-origin' })).toThrow();
    expect(() => loadConfig({ ...REQUIRED, AGENT_SESSION_SECRET: 'short' })).toThrow(/AGENT_SESSION_SECRET/);
    expect(() => loadConfig({ ...REQUIRED, AGENT_PASSCODE: '12345' })).toThrow(/AGENT_PASSCODE/);
    expect(() => loadConfig({ ...REQUIRED, AGENT_SECURE_COOKIE: 'yes' })).toThrow();
  });

  it('parses the deployed session settings; an empty passcode means none', () => {
    expect(
      loadConfig({ ...REQUIRED, AGENT_PASSCODE: 'open-sesame', AGENT_SECURE_COOKIE: 'true', AGENT_SESSION_TTL_SECONDS: '600' }).session,
    ).toEqual({ secret: REQUIRED.AGENT_SESSION_SECRET, passcode: 'open-sesame', secureCookie: true, ttlSeconds: 600 });
    expect(loadConfig({ ...REQUIRED, AGENT_PASSCODE: '' }).session.passcode).toBeUndefined();
    expect(loadConfig({ ...REQUIRED, AGENT_WEB_DIR: '/app/apps/web/dist' }).webDir).toBe('/app/apps/web/dist');
    expect(loadConfig({ ...REQUIRED, AGENT_WEB_DIR: '' }).webDir).toBeUndefined();
  });
});
