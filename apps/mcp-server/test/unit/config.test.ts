import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';

const REQUIRED = {
  MCP_DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
  SERVICE_TOKEN: 'service-token-0123456789',
};

describe('mcp-server loadConfig', () => {
  it('applies the documented defaults', () => {
    expect(loadConfig(REQUIRED)).toEqual({
      databaseUrl: REQUIRED.MCP_DATABASE_URL,
      bindHost: '127.0.0.1',
      mcpPort: 7410,
      internalPort: 7411,
      serviceToken: REQUIRED.SERVICE_TOKEN,
      allowedOrigins: [],
      allowAnonWrites: false,
      bodyLimitBytes: 64 * 1024,
      mcpRatePerMinute: 120,
      internalRatePerMinute: 300,
    });
  });

  it('parses ports, limits, the origin list and the anon-writes flag from strings', () => {
    const config = loadConfig({
      ...REQUIRED,
      MCP_PORT: '8000',
      INTERNAL_PORT: '8001',
      MCP_ALLOWED_ORIGINS: ' http://localhost:6274 , ,http://127.0.0.1:6274',
      ALLOW_ANON_WRITES: '1',
      MCP_BODY_LIMIT_BYTES: '1024',
      MCP_RATE_PER_MINUTE: '5',
    });
    expect(config).toMatchObject({
      mcpPort: 8000,
      internalPort: 8001,
      allowedOrigins: ['http://localhost:6274', 'http://127.0.0.1:6274'],
      allowAnonWrites: true,
      bodyLimitBytes: 1024,
      mcpRatePerMinute: 5,
    });
  });

  it('treats any ALLOW_ANON_WRITES value other than "1" as off', () => {
    expect(loadConfig({ ...REQUIRED, ALLOW_ANON_WRITES: 'true' }).allowAnonWrites).toBe(false);
  });

  it('rejects a missing database URL and a short service token', () => {
    expect(() => loadConfig({ SERVICE_TOKEN: REQUIRED.SERVICE_TOKEN })).toThrow();
    expect(() => loadConfig({ ...REQUIRED, SERVICE_TOKEN: 'short' })).toThrow(/at least 16/);
  });

  it('rejects out-of-range ports', () => {
    expect(() => loadConfig({ ...REQUIRED, MCP_PORT: '70000' })).toThrow();
    expect(() => loadConfig({ ...REQUIRED, INTERNAL_PORT: '-1' })).toThrow();
  });
});
