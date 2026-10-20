import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

export const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'db', 'migrations');

/**
 * Applies `db/migrations/*.sql` in name order, each in its own transaction.
 * Applied migrations are recorded with a checksum; editing an applied file is an error.
 */
export async function migrate(databaseUrl: string, log: (msg: string) => void = console.log): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        name       text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const done = new Map(
      (await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM public.schema_migrations'))
        .rows.map((r) => [r.name, r.checksum]),
    );
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = done.get(file);
      if (previous !== undefined) {
        if (previous !== checksum) throw new Error(`Applied migration ${file} was modified`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO public.schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
      log(`applied ${file}`);
    }
  } finally {
    await client.end();
  }
  return applied;
}

/** Drops and recreates a database (test use only). */
export async function recreateDatabase(adminUrl: string, name: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const ident = client.escapeIdentifier(name);
    await client.query(`DROP DATABASE IF EXISTS ${ident} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${ident}`);
  } finally {
    await client.end();
  }
}
