import pg from 'pg';
import { bootstrap } from '../scripts/lib/bootstrap.ts';
import { migrate, recreateDatabase } from '../scripts/lib/migrator.ts';
import { ADMIN_URL, AGENT_PASSWORD, MCP_PASSWORD, TEST_ADMIN_URL, TEST_DB } from './env.ts';

export default async function setup(): Promise<() => Promise<void>> {
  const quiet = () => {};
  await bootstrap({
    adminUrl: ADMIN_URL,
    databases: [],
    roles: { pantry_mcp: MCP_PASSWORD, pantry_agent: AGENT_PASSWORD },
    log: quiet,
  });
  await recreateDatabase(ADMIN_URL, TEST_DB);
  await migrate(TEST_ADMIN_URL, quiet);
  return checkLedger;
}

/**
 * R17: after the whole suite, every batch any test touched still equals the sum of its events (I1).
 * Fails the run otherwise, naming the batches.
 */
async function checkLedger(): Promise<void> {
  const client = new pg.Client({ connectionString: TEST_ADMIN_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string; quantity: string; events: string }>(
      `SELECT b.id, b.quantity::text, COALESCE(sum(e.delta), 0)::text AS events
         FROM pantry.batches b LEFT JOIN pantry.inventory_events e ON e.batch_id = b.id
        GROUP BY b.id, b.quantity
       HAVING b.quantity <> COALESCE(sum(e.delta), 0)`,
    );
    if (rows.length > 0) {
      const list = rows.map((r) => `${r.id} (quantity ${r.quantity}, events ${r.events})`).join(', ');
      throw new Error(`R17: ${rows.length} batch(es) break I1 after the suite: ${list}`);
    }
  } finally {
    await client.end();
  }
}
