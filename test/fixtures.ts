import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import pg from 'pg';
import { META_CONVERSATION_ID, META_REQUEST_ID, sha256Hex } from '@pantrymos/shared';
import type { RunningServers } from '../apps/mcp-server/src/app.ts';
import type { Config } from '../apps/mcp-server/src/config.ts';
import type { PackageDateType } from '../apps/mcp-server/src/domain/dates.ts';
import type { BaseUnit, Category } from '../apps/mcp-server/src/domain/items.ts';
import { priorityOf } from '../apps/mcp-server/src/domain/priority.ts';
import { seedDemo } from '../scripts/lib/seed.ts';
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

export interface DemoKitchen extends HouseholdFixture {
  /** Catalog item ids by name. */
  items: Record<string, string>;
}

/** A household with the real demo catalog and recipes (the seed), and no stock yet. */
export async function createDemoKitchen(timezone?: string): Promise<DemoKitchen> {
  const hh = await createHousehold(timezone);
  return withAdmin(async (admin) => {
    await seedDemo(admin, { householdId: hh.householdId, householdName: 'Test kitchen', inspector: false });
    const { rows } = await admin.query<{ id: string; name: string }>(
      `SELECT id, name FROM pantry.items WHERE household_id = $1`,
      [hh.householdId],
    );
    return { ...hh, items: Object.fromEntries(rows.map((r) => [r.name, r.id])) };
  });
}

/** Adds one batch per entry (base units), bought `daysAgo` days before today, via createBatch. */
export async function stockKitchen(kitchen: DemoKitchen, stock: Record<string, number>, daysAgo = 1): Promise<Record<string, string>> {
  const tz = await withAdmin(async (admin) => {
    const { rows } = await admin.query<{ timezone: string }>(`SELECT timezone FROM pantry.households WHERE id = $1`, [
      kitchen.householdId,
    ]);
    return rows[0]!.timezone;
  });
  const today = await todayIn(tz);
  const purchased = new Date(Date.parse(`${today}T00:00:00Z`) - daysAgo * 86_400_000).toISOString().slice(0, 10);
  const batches: Record<string, string> = {};
  for (const [name, quantity] of Object.entries(stock)) {
    const itemId = kitchen.items[name];
    if (!itemId) throw new Error(`Unknown demo item ${name}`);
    batches[name] = await createBatch(kitchen.householdId, itemId, { quantity, purchased_at: purchased });
  }
  return batches;
}

/**
 * Changes a batch the way a committed adjustment would (M3 adds the real flow): an adjust event and
 * the matching quantity, version and status change, so I1 still holds. `client` lets a test run it
 * inside its own transaction to race a confirm.
 */
export async function adjustBatch(householdId: string, batchId: string, delta: number, client?: pg.ClientBase): Promise<void> {
  const run = async (db: pg.ClientBase) => {
    const [proposalId, confirmationId, opId] = [randomUUID(), randomUUID(), randomUUID()];
    const { rows } = await db.query<{ item_id: string }>(`SELECT item_id FROM pantry.batches WHERE id = $1 FOR UPDATE`, [batchId]);
    await db.query(
      `INSERT INTO pantry.proposals (id, household_id, conversation_id, kind, subject_key, input, payload, preconditions, status, expires_at)
       VALUES ($1, $2, $3, 'adjust', $4, '{}', '{}', '{}', 'committed', now())`,
      [proposalId, householdId, randomUUID(), `fixture:${proposalId}`],
    );
    await db.query(
      `INSERT INTO pantry.confirmations (id, household_id, proposal_id, version, user_id, channel, request_id, outcome)
       VALUES ($1, $2, $3, 1, 'fixture', 'ui_click', $4, 'committed')`,
      [confirmationId, householdId, proposalId, randomUUID()],
    );
    await db.query(
      `INSERT INTO pantry.operations (id, household_id, kind, proposal_id, proposal_version, confirmation_id, summary)
       VALUES ($1, $2, 'adjust', $3, 1, $4, '{}')`,
      [opId, householdId, proposalId, confirmationId],
    );
    await db.query(
      `INSERT INTO pantry.inventory_events (id, household_id, operation_id, batch_id, item_id, delta, reason)
       VALUES ($1, $2, $3, $4, $5, $6, 'adjust')`,
      [randomUUID(), householdId, opId, batchId, rows[0]!.item_id, delta],
    );
    await db.query(
      `UPDATE pantry.batches SET quantity = quantity + $2, version = version + 1,
              status = CASE WHEN quantity + $2 = 0 THEN 'depleted' ELSE 'active' END
        WHERE id = $1`,
      [batchId, delta],
    );
  };
  if (client) return run(client);
  return withAdmin(async (admin) => {
    await admin.query('BEGIN');
    await run(admin);
    await admin.query('COMMIT');
  });
}

/** POSTs (or PATCHes) to the internal listener with the service token. */
export async function internalCall(
  servers: RunningServers,
  path: string,
  body: unknown,
  method: 'POST' | 'PATCH' = 'POST',
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { port } = servers.internal.server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-service-token': TEST_SERVICE_TOKEN },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** I1: every batch's quantity equals the sum of its events. Returns the ids of batches that break it. */
export async function ledgerMismatches(householdId: string): Promise<string[]> {
  return withAdmin(async (admin) => {
    const { rows } = await admin.query<{ id: string }>(
      `SELECT b.id FROM pantry.batches b
         LEFT JOIN pantry.inventory_events e ON e.batch_id = b.id
        WHERE b.household_id = $1
        GROUP BY b.id, b.quantity
       HAVING b.quantity <> COALESCE(sum(e.delta), 0)`,
      [householdId],
    );
    return rows.map((r) => r.id);
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

/** Calls a write tool with fresh (or given) request and conversation ids in `_meta`. */
export function callWrite(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  ids: { requestId?: string; conversationId?: string } = {},
) {
  return client.callTool({
    name,
    arguments: args,
    _meta: {
      [META_REQUEST_ID]: ids.requestId ?? randomUUID(),
      [META_CONVERSATION_ID]: ids.conversationId ?? randomUUID(),
    },
  });
}

/** Everything creamy spinach pasta for 3 needs (the demo dish), with scallions. */
export const PASTA_STOCK: Record<string, number> = {
  pasta: 500,
  spinach: 300,
  milk: 1000,
  'garlic clove': 5,
  butter: 100,
  parmesan: 100,
  scallion: 4,
};

/** Stocks the kitchen for the demo dish and starts it; returns the session id. */
export async function startPasta(
  kitchen: DemoKitchen,
  client: Client,
  stock: Record<string, number> = PASTA_STOCK,
): Promise<string> {
  await stockKitchen(kitchen, stock);
  const res = await callWrite(client, 'start_cooking', { recipe_name: 'creamy spinach pasta' });
  const out = res.structuredContent as { session_id?: string } | undefined;
  if (!out?.session_id) throw new Error(`start_cooking failed: ${JSON.stringify(res.content)}`);
  return out.session_id;
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
    proposeRatePerMinute: 1000,
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
