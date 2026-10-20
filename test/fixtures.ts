import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import pg from 'pg';
import { sha256Hex } from '@pantrymos/shared';
import type { RunningServers } from '../apps/mcp-server/src/app.ts';
import type { Config } from '../apps/mcp-server/src/config.ts';
import type { PackageDateType } from '../apps/mcp-server/src/domain/dates.ts';
import type { BaseUnit, Category } from '../apps/mcp-server/src/domain/items.ts';
import { priorityOf } from '../apps/mcp-server/src/domain/priority.ts';
import { TEST_ADMIN_URL, TEST_MCP_DB_URL } from './env.ts';

export const TEST_SERVICE_TOKEN = 'test-service-token-0123456789';
export const INSPECTOR_ORIGIN = 'http://localhost:6274';

export interface HouseholdFixture {
  householdId: string;
  token: string;
  revokedToken: string;
}

/** Runs `fn` with a superuser connection to the test database (bypasses role privileges). */
export async function withAdmin<T>(fn: (admin: pg.Client) => Promise<T>): Promise<T> {
  const admin = new pg.Client({ connectionString: TEST_ADMIN_URL });
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

/** Creates an isolated household with one valid and one revoked MCP client token. */
export async function createHousehold(timezone = 'America/Los_Angeles'): Promise<HouseholdFixture> {
  return withAdmin(async (admin) => {
    const householdId = randomUUID();
    const token = randomBytes(24).toString('hex');
    const revokedToken = randomBytes(24).toString('hex');
    await admin.query(`INSERT INTO pantry.households (id, name, timezone) VALUES ($1, 'Test kitchen', $2)`, [
      householdId,
      timezone,
    ]);
    await admin.query(
      `INSERT INTO pantry.api_clients (id, household_id, name, token_hash) VALUES ($1, $2, 'test', $3)`,
      [randomUUID(), householdId, sha256Hex(token)],
    );
    await admin.query(
      `INSERT INTO pantry.api_clients (id, household_id, name, token_hash, revoked_at) VALUES ($1, $2, 'old', $3, now())`,
      [randomUUID(), householdId, sha256Hex(revokedToken)],
    );
    return { householdId, token, revokedToken };
  });
}

export interface ItemSpec {
  name: string;
  aliases?: string[];
  base_unit?: BaseUnit;
  category?: Category;
  default_shelf_days?: number | null;
}

export async function createItem(householdId: string, spec: ItemSpec): Promise<string> {
  const id = randomUUID();
  await withAdmin((admin) =>
    admin.query(
      `INSERT INTO pantry.items (id, household_id, name, aliases, base_unit, category, default_shelf_days)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        householdId,
        spec.name,
        spec.aliases ?? [],
        spec.base_unit ?? 'count',
        spec.category ?? 'other',
        spec.default_shelf_days ?? null,
      ],
    ),
  );
  return id;
}

export interface BatchSpec {
  quantity: number;
  purchased_at: string;
  opened_at?: string;
  package_date?: string;
  package_date_type?: PackageDateType;
  status?: 'active' | 'depleted' | 'discarded';
}

/**
 * Inserts a batch as if an intake had been confirmed: proposal, confirmation, operation and a
 * +quantity purchase event, so invariant I1 (quantity = Σ events) holds. Tests of intake itself
 * go through propose_intake and the confirm route instead.
 */
export async function createBatch(householdId: string, itemId: string, spec: BatchSpec): Promise<string> {
  return withAdmin(async (admin) => {
    const [proposalId, confirmationId, opId, batchId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const shelf = await admin.query<{ default_shelf_days: number | null }>(
      'SELECT default_shelf_days FROM pantry.items WHERE id = $1',
      [itemId],
    );
    const priority = priorityOf(
      { purchased_at: spec.purchased_at, package_date: spec.package_date ?? null },
      shelf.rows[0]?.default_shelf_days ?? null,
    );
    await admin.query('BEGIN');
    await admin.query(
      `INSERT INTO pantry.proposals (id, household_id, conversation_id, kind, subject_key, input, payload, preconditions, status, expires_at)
       VALUES ($1, $2, $3, 'intake', $4, '{}', '{}', '{}', 'committed', now())`,
      [proposalId, householdId, randomUUID(), `fixture:${proposalId}`],
    );
    await admin.query(
      `INSERT INTO pantry.confirmations (id, household_id, proposal_id, version, user_id, channel, request_id, outcome)
       VALUES ($1, $2, $3, 1, 'fixture', 'ui_click', $4, 'committed')`,
      [confirmationId, householdId, proposalId, randomUUID()],
    );
    await admin.query(
      `INSERT INTO pantry.operations (id, household_id, kind, proposal_id, proposal_version, confirmation_id, summary)
       VALUES ($1, $2, 'intake', $3, 1, $4, '{}')`,
      [opId, householdId, proposalId, confirmationId],
    );
    await admin.query(
      `INSERT INTO pantry.batches (id, household_id, item_id, quantity, purchased_at, opened_at, package_date,
                                   package_date_type, priority_date, priority_source, status, created_by_op)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        batchId,
        householdId,
        itemId,
        spec.quantity,
        spec.purchased_at,
        spec.opened_at ?? null,
        spec.package_date ?? null,
        spec.package_date ? (spec.package_date_type ?? 'unknown') : null,
        priority.priority_date,
        priority.priority_source,
        spec.status ?? (spec.quantity > 0 ? 'active' : 'depleted'),
        opId,
      ],
    );
    if (spec.quantity > 0) {
      await admin.query(
        `INSERT INTO pantry.inventory_events (id, household_id, operation_id, batch_id, item_id, delta, reason)
         VALUES ($1, $2, $3, $4, $5, $6, 'purchase')`,
        [randomUUID(), householdId, opId, batchId, itemId, spec.quantity],
      );
    }
    await admin.query('COMMIT');
    return batchId;
  });
}

/** "Today" in a timezone, computed by Postgres the same way the server does. */
export async function todayIn(timezone: string): Promise<string> {
  return withAdmin(async (admin) => {
    const { rows } = await admin.query<{ today: string }>(`SELECT (now() AT TIME ZONE $1)::date::text AS today`, [
      timezone,
    ]);
    return rows[0]!.today;
  });
}

/** An official SDK client connected to the test MCP listener with `token`. */
export async function connectMcpClient(servers: RunningServers, token: string): Promise<Client> {
  const { address, port } = servers.mcp.server.address() as AddressInfo;
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://${address}:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
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
    confirmRatePerMinute: 1000,
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
