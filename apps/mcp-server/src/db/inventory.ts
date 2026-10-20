// Read models over active batches.
import { dateLabel, type PackageDateType } from '../domain/dates.ts';
import type { BaseUnit } from '../domain/items.ts';
import type { Queryable } from './catalog.ts';

export interface BatchView {
  batch_id: string;
  item_id: string;
  item: string;
  unit: BaseUnit;
  quantity: number;
  /** Bumped on every quantity or status change; proposals pin it (§4.2). */
  version: number;
  priority_date: string;
  priority_source: 'package' | 'estimate';
  status: 'active' | 'depleted' | 'discarded';
  date_label: string;
}

interface Row {
  batch_id: string;
  item_id: string;
  item: string;
  unit: BaseUnit;
  quantity: string;
  version: number;
  purchased_at: string;
  opened_at: string | null;
  package_date: string | null;
  package_date_type: PackageDateType | null;
  priority_date: string;
  priority_source: 'package' | 'estimate';
  status: 'active' | 'depleted' | 'discarded';
}

const SELECT_BATCH = `
  SELECT b.id AS batch_id, i.id AS item_id, i.name AS item, i.base_unit AS unit, b.quantity::text AS quantity,
         b.version, b.purchased_at, b.opened_at, b.package_date, b.package_date_type, b.priority_date, b.priority_source,
         b.status
    FROM pantry.batches b
    JOIN pantry.items i ON i.id = b.item_id`;

function toView(r: Row, today: string): BatchView {
  return {
    batch_id: r.batch_id,
    item_id: r.item_id,
    item: r.item,
    unit: r.unit,
    quantity: Number(r.quantity),
    version: r.version,
    priority_date: r.priority_date,
    priority_source: r.priority_source,
    status: r.status,
    date_label: dateLabel(r, today),
  };
}

/**
 * Active batches with stock, in FEFO order: (priority_date, purchased_at, id), the same order
 * allocation uses (§6.2). Optionally only some items, and/or only batches due by `priorityUntil`.
 */
export async function activeBatches(
  q: Queryable,
  householdId: string,
  today: string,
  filter: { itemIds?: readonly string[]; priorityUntil?: string } = {},
): Promise<BatchView[]> {
  const { rows } = await q.query<Row>(
    `${SELECT_BATCH}
      WHERE b.household_id = $1 AND b.status = 'active' AND b.quantity > 0
        AND ($2::uuid[] IS NULL OR b.item_id = ANY ($2))
        AND ($3::date IS NULL OR b.priority_date <= $3)
      ORDER BY b.priority_date, b.purchased_at, b.id`,
    [householdId, filter.itemIds ?? null, filter.priorityUntil ?? null],
  );
  return rows.map((r) => toView(r, today));
}

/** Batches by id, whatever their status (a return may go to a depleted batch), ordered by id. */
export async function batchesByIds(q: Queryable, householdId: string, ids: readonly string[], today: string): Promise<BatchView[]> {
  if (ids.length === 0) return [];
  const { rows } = await q.query<Row>(`${SELECT_BATCH} WHERE b.household_id = $1 AND b.id = ANY ($2::uuid[]) ORDER BY b.id`, [
    householdId,
    ids,
  ]);
  return rows.map((r) => toView(r, today));
}
