import type { CatalogItem } from '../domain/items.ts';
import type { Pool } from './pool.ts';
import type { Tx } from './tx.ts';

export type Queryable = Pool | Tx;

export async function loadCatalog(q: Queryable, householdId: string): Promise<CatalogItem[]> {
  const { rows } = await q.query<CatalogItem>(
    `SELECT id, name, aliases, base_unit, category, default_shelf_days
       FROM pantry.items WHERE household_id = $1 ORDER BY name`,
    [householdId],
  );
  return rows;
}

/** Saved unit conversions, keyed by item id, then canonical unit → base quantity. */
export async function loadConversions(q: Queryable, householdId: string): Promise<Map<string, Map<string, number>>> {
  const { rows } = await q.query<{ item_id: string; unit: string; base_qty: string }>(
    `SELECT item_id, unit, base_qty::text FROM pantry.unit_conversions WHERE household_id = $1`,
    [householdId],
  );
  const byItem = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const units = byItem.get(r.item_id) ?? new Map<string, number>();
    units.set(r.unit, Number(r.base_qty));
    byItem.set(r.item_id, units);
  }
  return byItem;
}

/** "Today" in the household's timezone, computed by Postgres so app and DB never disagree (§2.4). */
export async function householdToday(q: Queryable, householdId: string): Promise<string> {
  const { rows } = await q.query<{ today: string }>(
    `SELECT (now() AT TIME ZONE timezone)::date::text AS today FROM pantry.households WHERE id = $1`,
    [householdId],
  );
  const today = rows[0]?.today;
  if (!today) throw new Error(`Unknown household ${householdId}`);
  return today;
}
