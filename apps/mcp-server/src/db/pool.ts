import pg from 'pg';

// Return DATE columns as 'YYYY-MM-DD' strings. The default parser builds a JS Date
// in the process timezone, which silently shifts household dates.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10 });
}

export type Pool = pg.Pool;
