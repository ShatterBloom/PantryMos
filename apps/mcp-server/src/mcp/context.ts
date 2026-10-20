import type { Config } from '../config.ts';
import type { Pool } from '../db/pool.ts';
import type { AuthContext } from '../security/auth.ts';

/** Per-request context handed to every tool. `auth` comes from the bearer token, never from tool input. */
export interface ToolContext {
  pool: Pool;
  auth: AuthContext;
  config: Config;
}

export async function householdToday(pool: Pool, householdId: string): Promise<string> {
  const { rows } = await pool.query<{ today: string }>(
    `SELECT (now() AT TIME ZONE timezone)::date::text AS today FROM pantry.households WHERE id = $1`,
    [householdId],
  );
  const today = rows[0]?.today;
  if (!today) throw new Error(`Unknown household ${householdId}`);
  return today;
}
