// Test environment: one throwaway database (`<name>_test`), recreated per run by global-setup.
import { loadEnv, requireEnv, withDatabase } from '../scripts/lib/env.ts';

loadEnv();

const credentialed = (url: string, user: string, password: string) => {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
};

export const ADMIN_URL = requireEnv('PG_ADMIN_URL', 'postgres://postgres:postgres@127.0.0.1:5432/postgres');
export const TEST_DB = `${requireEnv('PANTRY_DB_NAME', 'pantrymos')}_test`;
export const MCP_PASSWORD = requireEnv('PANTRY_MCP_PASSWORD', 'dev-mcp-password');
export const AGENT_PASSWORD = requireEnv('PANTRY_AGENT_PASSWORD', 'dev-agent-password');

export const TEST_ADMIN_URL = withDatabase(ADMIN_URL, TEST_DB);
export const TEST_MCP_DB_URL = credentialed(TEST_ADMIN_URL, 'pantry_mcp', MCP_PASSWORD);
export const TEST_AGENT_DB_URL = credentialed(TEST_ADMIN_URL, 'pantry_agent', AGENT_PASSWORD);
