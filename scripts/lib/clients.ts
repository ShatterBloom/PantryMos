// MCP client tokens for other apps (a desktop assistant, a voice terminal): one row per client in
// pantry.api_clients, holding only the token's hash. The name is what the app's inbox shows.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';

/** Names the seed and the agent own; another client can't take them. */
const RESERVED = new Set(['agent', 'inspector-dev']);

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export class ClientNameError extends Error {}

function checkName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 60) throw new ClientNameError('A client name is 1 to 60 characters.');
  if (RESERVED.has(trimmed.toLowerCase())) throw new ClientNameError(`"${trimmed}" is reserved.`);
  return trimmed;
}

/**
 * Issues a token for a new client of the household. Returns the raw token, which is not stored
 * anywhere. Refused while the household has an active client of that name: revoke it first.
 */
export async function issueClient(client: pg.ClientBase, householdId: string, name: string): Promise<{ clientId: string; token: string }> {
  const clientName = checkName(name);
  const active = await client.query(
    `SELECT 1 FROM pantry.api_clients WHERE household_id = $1 AND lower(name) = lower($2) AND revoked_at IS NULL`,
    [householdId, clientName],
  );
  if (active.rowCount !== 0) throw new ClientNameError(`"${clientName}" already has a token. Revoke it first to issue a new one.`);
  const clientId = randomUUID();
  const token = randomBytes(24).toString('hex');
  await client.query(`INSERT INTO pantry.api_clients (id, household_id, name, token_hash) VALUES ($1, $2, $3, $4)`, [
    clientId,
    householdId,
    clientName,
    sha256(token),
  ]);
  return { clientId, token };
}

/** Revokes the household's active client of that name. False: there was none. */
export async function revokeClient(client: pg.ClientBase, householdId: string, name: string): Promise<boolean> {
  const clientName = checkName(name);
  const res = await client.query(
    `UPDATE pantry.api_clients SET revoked_at = now() WHERE household_id = $1 AND lower(name) = lower($2) AND revoked_at IS NULL`,
    [householdId, clientName],
  );
  return (res.rowCount ?? 0) > 0;
}
