import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';

const REQUIRED = {
  AGENT_DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
  AGENT_MCP_URL: 'http://127.0.0.1:7410/mcp',
  AGENT_INTERNAL_URL: 'http://127.0.0.1:7411',
  AGENT_MCP_TOKEN: 'agent-mcp-token-0123456789',
  SERVICE_TOKEN: 'service-token-0123456789',
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
    });
  });

  it('parses the bind host, port and body limit', () => {
    expect(loadConfig({ ...REQUIRED, AGENT_BIND_HOST: '0.0.0.0', AGENT_PORT: '9000', AGENT_BODY_LIMIT_BYTES: '2048' }))
      .toMatchObject({ bindHost: '0.0.0.0', port: 9000, bodyLimitBytes: 2048 });
  });

  it('rejects malformed URLs and short tokens', () => {
    expect(() => loadConfig({ ...REQUIRED, AGENT_MCP_URL: 'not a url' })).toThrow();
    expect(() => loadConfig({ ...REQUIRED, AGENT_MCP_TOKEN: 'short' })).toThrow(/AGENT_MCP_TOKEN/);
    expect(() => loadConfig({ ...REQUIRED, SERVICE_TOKEN: 'short' })).toThrow(/SERVICE_TOKEN/);
  });
});
