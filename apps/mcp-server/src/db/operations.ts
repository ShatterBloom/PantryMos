// Committed operations, as the ledger records them (IMPLEMENTATION_PLAN §2.1, §7.4 list_recent_operations).
import type { ProposalKind } from './proposals.ts';
import type { Queryable } from './catalog.ts';

export interface OperationRow {
  operation_id: string;
  kind: ProposalKind;
  session_id: string | null;
  recipe: string | null;
  reverted: boolean;
  created_at: Date;
  /** Net change per item over the operation's events, in base units. */
  changes: Array<{ item_id: string; delta: number }>;
}

/** The household's most recent operations, newest first. */
export async function recentOperations(q: Queryable, householdId: string, limit: number): Promise<OperationRow[]> {
  const { rows } = await q.query<Omit<OperationRow, 'changes'> & { changes: Array<{ item_id: string; delta: string }> }>(
    `SELECT o.id AS operation_id, o.kind, o.session_id, r.name AS recipe, o.reverted_by_op IS NOT NULL AS reverted,
            o.created_at,
            COALESCE((SELECT json_agg(json_build_object('item_id', e.item_id, 'delta', e.delta::text) ORDER BY e.item_id)
                        FROM (SELECT item_id, sum(delta) AS delta FROM pantry.inventory_events
                               WHERE operation_id = o.id GROUP BY item_id HAVING sum(delta) <> 0) e), '[]') AS changes
       FROM pantry.operations o
       LEFT JOIN pantry.cooking_sessions s ON s.id = o.session_id
       LEFT JOIN pantry.recipes r ON r.id = s.recipe_id
      WHERE o.household_id = $1
      ORDER BY o.created_at DESC, o.id
      LIMIT $2`,
    [householdId, limit],
  );
  return rows.map((r) => ({ ...r, changes: r.changes.map((c) => ({ item_id: c.item_id, delta: Number(c.delta) })) }));
}
