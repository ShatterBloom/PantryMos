import type { Config } from '../config.ts';
import type { Pool } from '../db/pool.ts';
import type { AuthContext } from '../security/auth.ts';

/** Per-request context handed to every tool. `auth` comes from the bearer token, never from tool input. */
export interface ToolContext {
  pool: Pool;
  auth: AuthContext;
  config: Config;
}
