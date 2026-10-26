// Issues or revokes an MCP token for another app in the agent's household (AGENT_HOUSEHOLD_ID),
// as the Postgres superuser.
// Usage: node scripts/mcp-client.ts "Claude Desktop"            prints a new token once
//        node scripts/mcp-client.ts --revoke "Claude Desktop"
import { parseArgs } from 'node:util';
import pg from 'pg';
import { ClientNameError, issueClient, revokeClient } from './lib/clients.ts';
import { agentHouseholdId, loadEnv, requireEnv, withDatabase } from './lib/env.ts';

loadEnv();

const { values, positionals } = parseArgs({ allowPositionals: true, options: { revoke: { type: 'boolean', default: false } } });
const name = positionals.join(' ');
if (!name) {
  console.error('Usage: node scripts/mcp-client.ts [--revoke] <client name>');
  process.exit(2);
}

const householdId = agentHouseholdId();
const adminUrl = requireEnv('PG_ADMIN_URL', 'postgres://postgres:postgres@127.0.0.1:5432/postgres');
const dbName = requireEnv('PANTRY_DB_NAME', 'pantrymos');
const client = new pg.Client({ connectionString: withDatabase(adminUrl, dbName) });
await client.connect();
try {
  if (values.revoke) {
    console.log((await revokeClient(client, householdId, name)) ? `Revoked the token of "${name}".` : `"${name}" has no active token.`);
  } else {
    const { token } = await issueClient(client, householdId, name);
    // Shown once; only its hash is stored.
    console.log(`MCP token for "${name}" (shown once): ${token}`);
  }
} catch (err) {
  if (!(err instanceof ClientNameError)) throw err;
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
