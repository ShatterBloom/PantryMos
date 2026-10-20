// Demo data. Every step is idempotent, so the seed can run on every `docker compose up`.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { CATALOG } from '../../db/seed/catalog.ts';

export const INSPECTOR_CLIENT_NAME = 'inspector-dev';

export interface SeedOptions {
  householdId: string;
  householdName: string;
  /** The agent's MCP client; its token hash is (re)written on every run. */
  agent?: { clientId: string; token: string };
  /** Create a dev MCP Inspector token if the household has no active one (§11.2). */
  inspector: boolean;
}

export interface SeedResult {
  itemsCreated: number;
  /** Raw Inspector token, returned only when it was just created. It is not stored anywhere. */
  inspectorToken: string | null;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function seedDemo(client: pg.ClientBase, options: SeedOptions): Promise<SeedResult> {
  await client.query('BEGIN');
  try {
    await client.query(`INSERT INTO pantry.households (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [
      options.householdId,
      options.householdName,
    ]);

    if (options.agent) {
      await client.query(
        `INSERT INTO pantry.api_clients (id, household_id, name, token_hash) VALUES ($1, $2, 'agent', $3)
         ON CONFLICT (id) DO UPDATE SET token_hash = EXCLUDED.token_hash, revoked_at = NULL`,
        [options.agent.clientId, options.householdId, sha256(options.agent.token)],
      );
    }

    let itemsCreated = 0;
    for (const item of CATALOG) {
      const res = await client.query(
        `INSERT INTO pantry.items (id, household_id, name, aliases, base_unit, category, default_shelf_days)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (household_id, lower(name)) DO NOTHING`,
        [randomUUID(), options.householdId, item.name, item.aliases ?? [], item.base_unit, item.category, item.default_shelf_days],
      );
      itemsCreated += res.rowCount ?? 0;
    }

    let inspectorToken: string | null = null;
    if (options.inspector) {
      const existing = await client.query(
        `SELECT 1 FROM pantry.api_clients WHERE household_id = $1 AND name = $2 AND revoked_at IS NULL`,
        [options.householdId, INSPECTOR_CLIENT_NAME],
      );
      if (existing.rowCount === 0) {
        inspectorToken = randomBytes(24).toString('hex');
        await client.query(`INSERT INTO pantry.api_clients (id, household_id, name, token_hash) VALUES ($1, $2, $3, $4)`, [
          randomUUID(),
          options.householdId,
          INSPECTOR_CLIENT_NAME,
          sha256(inspectorToken),
        ]);
      }
    }

    await client.query('COMMIT');
    return { itemsCreated, inspectorToken };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}
