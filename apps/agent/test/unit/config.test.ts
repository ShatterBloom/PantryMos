import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';

const REQUIRED = {
  AGENT_DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
  AGENT_MCP_URL: 'http://127.0.0.1:7410/mcp',
  AGENT_INTERNAL_URL: 'http://127.0.0.1:7411',
  AGENT_MCP_TOKEN: 'agent-mcp-token-0123456789',
  SERVICE_TOKEN: 'service-token-0123456789',
  AGENT_HOUSEHOLD_ID: '00000000-0000-4000-8000-000000000001',
  AGENT_SESSION_SECRET: 'session-secret-0123456789abcdefghij',
};

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
      bedrock: { region: 'ap-southeast-2', modelId: 'apac.amazon.nova-pro-v1:0', maxTokens: 1024 },
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
      bedrock: { region: 'us-east-1', modelId: 'amazon.nova-lite-v1:0', maxTokens: 512 },
    });
    expect(loadConfig({ ...REQUIRED, AWS_REGION: 'us-east-1', BEDROCK_REGION: 'us-west-2' }).bedrock.region).toBe('us-west-2');
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
  });
});
