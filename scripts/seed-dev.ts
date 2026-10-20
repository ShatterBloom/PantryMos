// Seeds the demo household and the agent's MCP client token. Idempotent.
// Runs as the Postgres superuser against the app database. Usage: node scripts/seed-dev.ts
// (M1 extends this with the catalog, recipes and sample history.)
import { createHash } from 'node:crypto';
import pg from 'pg';
import { loadEnv, requireEnv, withDatabase } from './lib/env.ts';

loadEnv();

const DEMO_HOUSEHOLD_ID = '00000000-0000-4000-8000-000000000001';
const AGENT_CLIENT_ID = '00000000-0000-4000-8000-0000000000a1';

const adminUrl = requireEnv('PG_ADMIN_URL', 'postgres://postgres:postgres@127.0.0.1:5432/postgres');
const dbName = requireEnv('PANTRY_DB_NAME', 'pantrymos');
const agentToken = requireEnv('AGENT_MCP_TOKEN');

const client = new pg.Client({ connectionString: withDatabase(adminUrl, dbName) });
await client.connect();
try {
  await client.query(
    `INSERT INTO pantry.households (id, name) VALUES ($1, 'Demo kitchen') ON CONFLICT (id) DO NOTHING`,
    [DEMO_HOUSEHOLD_ID],
  );
  await client.query(
    `INSERT INTO pantry.api_clients (id, household_id, name, token_hash) VALUES ($1, $2, 'agent', $3)
     ON CONFLICT (id) DO UPDATE SET token_hash = EXCLUDED.token_hash, revoked_at = NULL`,
    [AGENT_CLIENT_ID, DEMO_HOUSEHOLD_ID, createHash('sha256').update(agentToken).digest('hex')],
  );
  console.log('seed: demo household and agent client ready');
} finally {
  await client.end();
}
