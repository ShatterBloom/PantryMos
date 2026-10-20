// Committing an intake card: new catalog items and conversions, then one batch per line with its
// +quantity purchase event (IMPLEMENTATION_PLAN §4.3 step 6).
import { randomUUID } from 'node:crypto';
import { applyDelta, lockKeys } from '../db/ledger.ts';
import type { Tx } from '../db/tx.ts';
import type { IntakePayload, IntakePreconditions, ItemRef } from '../domain/intake.ts';
import type { Executor, LockedProposal } from './types.ts';

const payloadOf = (p: LockedProposal) => p.payload as IntakePayload;
const preconditionsOf = (p: LockedProposal) => p.preconditions as IntakePreconditions;

const conversionOwner = (c: ItemRef) => c.item_id ?? `new:${c.new_item}`;

export const intakeExecutor: Executor = {
  async lockAndCheck(tx, proposal) {
    const { absent_items, absent_conversions } = preconditionsOf(proposal).catalog;
    // Rows that don't exist yet can't be locked FOR UPDATE; advisory locks on the catalog keys
    // serialize concurrent creators of the same item or conversion (R27).
    await lockKeys(tx, [
      ...absent_items.map((name) => `item:${proposal.household_id}:${name}`),
      ...absent_conversions.map((c) => `conv:${conversionOwner(c)}:${c.unit}`),
    ]);

    if (absent_items.length > 0) {
      const taken = await tx.query(
        `SELECT 1 FROM pantry.items WHERE household_id = $1 AND lower(name) = ANY ($2::text[]) LIMIT 1`,
        [proposal.household_id, absent_items],
      );
      if (taken.rowCount !== 0) return 'catalog_changed';
    }
    const existing = absent_conversions.filter((c) => c.item_id !== null);
    if (existing.length > 0) {
      const taken = await tx.query(
        `SELECT 1 FROM pantry.unit_conversions c
           JOIN unnest($1::uuid[], $2::text[]) AS w(item_id, unit) ON c.item_id = w.item_id AND c.unit = w.unit
          LIMIT 1`,
        [existing.map((c) => c.item_id), existing.map((c) => c.unit)],
      );
      if (taken.rowCount !== 0) return 'catalog_changed';
    }
    return null;
  },

  summary(proposal) {
    const { lines, new_items, new_conversions } = payloadOf(proposal);
    return {
      lines: lines.map((l) => ({ item: l.item, quantity: l.quantity_base, unit: l.base_unit })),
      new_items: new_items.map((i) => i.name),
      new_conversions: new_conversions.map((c) => ({ item: c.item, unit: c.unit, base_qty: c.base_qty })),
    };
  },

  async execute(tx, proposal, operationId) {
    const householdId = proposal.household_id;
    const { lines, new_items, new_conversions } = payloadOf(proposal);

    const newIds = new Map<string, string>();
    for (const item of new_items) {
      const id = randomUUID();
      newIds.set(item.key, id);
      await tx.query(
        `INSERT INTO pantry.items (id, household_id, name, aliases, base_unit, category, default_shelf_days, created_by_op)
         VALUES ($1, $2, $3, '{}', $4, $5, $6, $7)`,
        [id, householdId, item.name, item.base_unit, item.category, item.default_shelf_days, operationId],
      );
    }
    const itemIdOf = (ref: ItemRef) => ref.item_id ?? newIds.get(ref.new_item!)!;

    for (const c of new_conversions) {
      await tx.query(
        `INSERT INTO pantry.unit_conversions (household_id, item_id, unit, base_qty, created_by_op)
         VALUES ($1, $2, $3, $4, $5)`,
        [householdId, itemIdOf(c), c.unit, c.base_qty, operationId],
      );
    }

    for (const line of lines) {
      const batchId = randomUUID();
      const itemId = itemIdOf(line);
      // Created empty (version 0); the purchase event brings it to its quantity and version 1.
      await tx.query(
        `INSERT INTO pantry.batches (id, household_id, item_id, quantity, purchased_at, opened_at, package_date,
                                     package_date_type, priority_date, priority_source, status, version, created_by_op)
         VALUES ($1, $2, $3, 0, $4, $5, $6, $7, $8, $9, 'depleted', 0, $10)`,
        [
          batchId,
          householdId,
          itemId,
          line.purchased_at,
          line.opened_at,
          line.package_date,
          line.package_date_type,
          line.priority_date,
          line.priority_source,
          operationId,
        ],
      );
      await applyDelta(tx, { householdId, operationId, batchId, itemId, delta: line.quantity_base, reason: 'purchase' });
    }
  },
};
