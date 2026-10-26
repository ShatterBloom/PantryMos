// Seeds the agent's household (AGENT_HOUSEHOLD_ID, the demo one by default): catalog, the agent's
// MCP client token, and a dev Inspector token.
// Idempotent. Runs as the Postgres superuser against the app database. Usage: node scripts/seed-dev.ts
import pg from 'pg';
import { agentHouseholdId, loadEnv, requireEnv, withDatabase } from './lib/env.ts';
import { seedDemo } from './lib/seed.ts';

loadEnv();

const AGENT_CLIENT_ID = '00000000-0000-4000-8000-0000000000a1';

const adminUrl = requireEnv('PG_ADMIN_URL', 'postgres://postgres:postgres@127.0.0.1:5432/postgres');
const dbName = requireEnv('PANTRY_DB_NAME', 'pantrymos');
const agentToken = requireEnv('AGENT_MCP_TOKEN');

const client = new pg.Client({ connectionString: withDatabase(adminUrl, dbName) });
await client.connect();
try {
  const result = await seedDemo(client, {
    householdId: agentHouseholdId(),
    householdName: 'Demo kitchen',
    agent: { clientId: AGENT_CLIENT_ID, token: agentToken },
    inspector: true,
  });
  console.log(
    `seed: demo household ready (${result.itemsCreated} new catalog items, ${result.recipesCreated} new recipes)`,
  );
  if (result.inspectorToken) {
    // Printed once; only its hash is stored. Revoke the row in pantry.api_clients to get a new one.
    console.log(`seed: MCP Inspector token (shown once): ${result.inspectorToken}`);
  }
} finally {
  await client.end();
}
