import { bootstrap } from '../scripts/lib/bootstrap.ts';
import { migrate, recreateDatabase } from '../scripts/lib/migrator.ts';
import { ADMIN_URL, AGENT_PASSWORD, MCP_PASSWORD, TEST_ADMIN_URL, TEST_DB } from './env.ts';

export default async function setup(): Promise<void> {
  const quiet = () => {};
  await bootstrap({
    adminUrl: ADMIN_URL,
    databases: [],
    roles: { pantry_mcp: MCP_PASSWORD, pantry_agent: AGENT_PASSWORD },
    log: quiet,
  });
  await recreateDatabase(ADMIN_URL, TEST_DB);
  await migrate(TEST_ADMIN_URL, quiet);
}
