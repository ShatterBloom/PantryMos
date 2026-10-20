import type { Config } from '../config.ts';
import type { Pool } from '../db/pool.ts';
import type { AuthContext } from '../security/auth.ts';
import type { FixedWindowLimiter } from '../security/rateLimit.ts';

/** Per-request context handed to every tool. `auth` comes from the bearer token, never from tool input. */
export interface ToolContext {
  pool: Pool;
  auth: AuthContext;
  config: Config;
  /** propose_* calls per client token (§11.5), shared across requests. */
  proposeLimiter: FixedWindowLimiter;
}
