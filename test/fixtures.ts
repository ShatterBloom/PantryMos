import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sha256Hex } from '@pantrymos/shared';
import type { Config } from '../apps/mcp-server/src/config.ts';
import { TEST_ADMIN_URL, TEST_MCP_DB_URL } from './env.ts';

export const TEST_SERVICE_TOKEN = 'test-service-token-0123456789';
export const INSPECTOR_ORIGIN = 'http://localhost:6274';

export interface HouseholdFixture {
  householdId: string;
  token: string;
  revokedToken: string;
}

/** Creates an isolated household with one valid and one revoked MCP client token. */
export async function createHousehold(): Promise<HouseholdFixture> {
  const admin = new pg.Client({ connectionString: TEST_ADMIN_URL });
  await admin.connect();
  try {
    const householdId = randomUUID();
    const token = randomBytes(24).toString('hex');
    const revokedToken = randomBytes(24).toString('hex');
    await admin.query(`INSERT INTO pantry.households (id, name) VALUES ($1, 'Test kitchen')`, [householdId]);
    await admin.query(
      `INSERT INTO pantry.api_clients (id, household_id, name, token_hash) VALUES ($1, $2, 'test', $3)`,
      [randomUUID(), householdId, sha256Hex(token)],
    );
    await admin.query(
      `INSERT INTO pantry.api_clients (id, household_id, name, token_hash, revoked_at) VALUES ($1, $2, 'old', $3, now())`,
      [randomUUID(), householdId, sha256Hex(revokedToken)],
    );
    return { householdId, token, revokedToken };
  } finally {
    await admin.end();
  }
}

export function mcpTestConfig(overrides: Partial<Config> = {}): Config {
  return {
    databaseUrl: TEST_MCP_DB_URL,
    bindHost: '127.0.0.1',
    mcpPort: 0,
    internalPort: 0,
    serviceToken: TEST_SERVICE_TOKEN,
    allowedOrigins: [INSPECTOR_ORIGIN],
    allowAnonWrites: false,
    bodyLimitBytes: 64 * 1024,
    mcpRatePerMinute: 1000,
    internalRatePerMinute: 1000,
    ...overrides,
  };
}

export const INITIALIZE_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  },
};

export const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};
