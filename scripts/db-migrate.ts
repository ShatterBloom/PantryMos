// Applies migrations as the Postgres superuser.
// Usage: pnpm db:migrate            → app database
//        pnpm db:reset-test         → drop + recreate + migrate the test database
import { loadEnv, requireEnv, withDatabase } from './lib/env.ts';
import { migrate, recreateDatabase } from './lib/migrator.ts';

loadEnv();

const adminUrl = requireEnv('PG_ADMIN_URL', 'postgres://postgres:postgres@127.0.0.1:5432/postgres');
const dbName = requireEnv('PANTRY_DB_NAME', 'pantrymos');

if (process.argv.includes('--reset-test')) {
  const testDb = `${dbName}_test`;
  await recreateDatabase(adminUrl, testDb);
  await migrate(withDatabase(adminUrl, testDb));
  console.log(`${testDb}: reset and migrated`);
} else {
  const applied = await migrate(withDatabase(adminUrl, dbName));
  console.log(applied.length ? `${dbName}: ${applied.length} migration(s) applied` : `${dbName}: up to date`);
}
