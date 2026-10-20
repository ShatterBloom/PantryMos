// Creates the per-service login roles and the app/test databases. Idempotent.
// Runs as the Postgres superuser (PG_ADMIN_URL). Usage: pnpm db:bootstrap
import { bootstrap } from './lib/bootstrap.ts';
import { loadEnv, requireEnv } from './lib/env.ts';

loadEnv();

const dbName = requireEnv('PANTRY_DB_NAME', 'pantrymos');
await bootstrap({
  adminUrl: requireEnv('PG_ADMIN_URL', 'postgres://postgres:postgres@127.0.0.1:5432/postgres'),
  databases: [dbName, `${dbName}_test`],
  roles: {
    pantry_mcp: requireEnv('PANTRY_MCP_PASSWORD', 'dev-mcp-password'),
    pantry_agent: requireEnv('PANTRY_AGENT_PASSWORD', 'dev-agent-password'),
  },
});
