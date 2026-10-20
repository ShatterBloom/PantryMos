import { timingSafeEqual } from 'node:crypto';
import { sha256Hex } from '@pantrymos/shared';
import type { Pool } from '../db/pool.ts';

export interface AuthContext {
  clientId: string;
  householdId: string;
}

/** Extracts the token from `Authorization: Bearer <token>`. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1] ?? null;
}

/** Resolves an MCP client token to its household (IMPLEMENTATION_PLAN §11.2). */
export async function resolveClient(pool: Pool, token: string): Promise<AuthContext | null> {
  const { rows } = await pool.query<{ id: string; household_id: string }>(
    'SELECT id, household_id FROM pantry.api_clients WHERE token_hash = $1 AND revoked_at IS NULL',
    [sha256Hex(token)],
  );
  const row = rows[0];
  return row ? { clientId: row.id, householdId: row.household_id } : null;
}

/** Constant-time comparison for the internal service token (§11.3). */
export function serviceTokenMatches(expected: string, provided: string | undefined): boolean {
  if (provided === undefined) return false;
  const a = Buffer.from(sha256Hex(expected));
  const b = Buffer.from(sha256Hex(provided));
  return timingSafeEqual(a, b);
}

/**
 * MCP 2025-11-25 requires validating Origin on Streamable HTTP (§11.4):
 * absent → non-browser client, allowed; present → must be allow-listed.
 */
export function originAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  if (origin === undefined) return true;
  return allowed.includes(origin);
}
