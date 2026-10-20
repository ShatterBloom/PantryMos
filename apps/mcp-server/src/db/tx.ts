import type pg from 'pg';
import type { Pool } from './pool.ts';

export type Tx = pg.PoolClient;

/** Runs `fn` in one transaction on a dedicated connection; rolls back on any exception. */
export async function withTransaction<T>(pool: Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const result = await fn(tx);
    await tx.query('COMMIT');
    return result;
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}
