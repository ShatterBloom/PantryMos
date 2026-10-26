// Tokens for other MCP clients (scripts/mcp-client.ts): issued once by name, revoked by name.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClientNameError, issueClient, revokeClient } from '../../../../scripts/lib/clients.ts';
import { createPool, type Pool } from '../../src/db/pool.ts';
import { resolveClient } from '../../src/security/auth.ts';
import { TEST_ADMIN_URL, TEST_MCP_DB_URL } from '../../../../test/env.ts';
import { createHousehold } from '../../../../test/fixtures.ts';

describe('MCP client tokens', () => {
  const admin = new pg.Client({ connectionString: TEST_ADMIN_URL });
  let pool: Pool;
  beforeAll(async () => {
    await admin.connect();
    pool = createPool(TEST_MCP_DB_URL);
  });
  afterAll(async () => {
    await admin.end();
    await pool.end();
  });

  it('issues a token that authenticates as the named client, storing only its hash', async () => {
    const { householdId } = await createHousehold();
    const issued = await issueClient(admin, householdId, '  Claude Desktop ');
    expect(issued.token).toMatch(/^[0-9a-f]{48}$/);
    expect(await resolveClient(pool, issued.token)).toEqual({ clientId: issued.clientId, householdId });
    const { rows } = await admin.query(`SELECT name, token_hash FROM pantry.api_clients WHERE id = $1`, [issued.clientId]);
    expect(rows[0].name).toBe('Claude Desktop');
    expect(rows[0].token_hash).not.toContain(issued.token);
  });

  it('refuses a second active token of the same name, and reserved or bad names', async () => {
    const { householdId } = await createHousehold();
    await issueClient(admin, householdId, 'Kitchen speaker');
    await expect(issueClient(admin, householdId, 'kitchen SPEAKER')).rejects.toBeInstanceOf(ClientNameError);
    for (const name of ['agent', 'Inspector-dev', '', 'x'.repeat(61)]) {
      await expect(issueClient(admin, householdId, name)).rejects.toBeInstanceOf(ClientNameError);
    }
    // Another household may use the name.
    const other = await createHousehold();
    await expect(issueClient(admin, other.householdId, 'Kitchen speaker')).resolves.toMatchObject({ token: expect.any(String) });
  });

  it('revokes by name, so the token stops working and the name can be issued again', async () => {
    const { householdId } = await createHousehold();
    const first = await issueClient(admin, householdId, 'Phone');
    expect(await revokeClient(admin, householdId, 'phone')).toBe(true);
    expect(await resolveClient(pool, first.token)).toBeNull();
    expect(await revokeClient(admin, householdId, 'Phone')).toBe(false);
    const second = await issueClient(admin, householdId, 'Phone');
    expect(await resolveClient(pool, second.token)).toMatchObject({ householdId });
  });
});
