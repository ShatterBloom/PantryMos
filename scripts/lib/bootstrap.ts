import pg from 'pg';

export interface BootstrapOptions {
  adminUrl: string;
  databases: string[];
  roles: Record<string, string>; // role name → password
  log?: (msg: string) => void;
}

/** Creates/updates login roles and creates missing databases. Idempotent. */
export async function bootstrap({ adminUrl, databases, roles, log = console.log }: BootstrapOptions): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    for (const [role, password] of Object.entries(roles)) {
      const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      const ident = client.escapeIdentifier(role);
      const pw = client.escapeLiteral(password);
      await client.query(
        exists.rowCount === 0 ? `CREATE ROLE ${ident} LOGIN PASSWORD ${pw}` : `ALTER ROLE ${ident} LOGIN PASSWORD ${pw}`,
      );
      log(`role ${role}: ready`);
    }
    for (const name of databases) {
      const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
      if (exists.rowCount === 0) {
        await client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`);
        log(`database ${name}: created`);
      }
    }
  } finally {
    await client.end();
  }
}
