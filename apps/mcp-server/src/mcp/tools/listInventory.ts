import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { dateLabel, type PackageDateType } from '../../domain/dates.ts';
import { householdToday, type ToolContext } from '../context.ts';

const BatchOut = z.object({
  batch_id: z.string(),
  quantity: z.number(),
  date_label: z.string(),
  priority_source: z.enum(['package', 'estimate']),
});

const ItemOut = z.object({
  item: z.string(),
  total: z.number(),
  unit: z.string(),
  batches: z.array(BatchOut),
});

interface Row {
  item_name: string;
  base_unit: string;
  batch_id: string;
  quantity: string;
  purchased_at: string;
  opened_at: string | null;
  package_date: string | null;
  package_date_type: PackageDateType | null;
  priority_source: 'package' | 'estimate';
}

export function registerListInventory(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_inventory',
    {
      title: 'List inventory',
      description:
        'Use to answer what is in the kitchen, optionally for one item (e.g. "do I have eggs?"). ' +
        'Returns active batches with quantities and a date_label that must be relayed verbatim; never infer expiry dates.',
      inputSchema: {
        item: z.string().trim().min(1).max(60).optional().describe('Item name or alias, e.g. "eggs". Omit for everything.'),
      },
      outputSchema: { today: z.string(), items: z.array(ItemOut) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ item }) => {
      const today = await householdToday(ctx.pool, ctx.auth.householdId);
      const { rows } = await ctx.pool.query<Row>(
        `SELECT i.name AS item_name, i.base_unit, b.id AS batch_id, b.quantity::text AS quantity,
                b.purchased_at, b.opened_at, b.package_date, b.package_date_type, b.priority_source
           FROM pantry.batches b
           JOIN pantry.items i ON i.id = b.item_id
          WHERE b.household_id = $1 AND b.status = 'active' AND b.quantity > 0
            AND ($2::text IS NULL OR lower(i.name) = lower($2)
                 OR lower($2) = ANY (SELECT lower(a) FROM unnest(i.aliases) a))
          ORDER BY i.name, b.priority_date, b.purchased_at, b.id`,
        [ctx.auth.householdId, item ?? null],
      );

      const byItem = new Map<string, z.infer<typeof ItemOut>>();
      for (const r of rows) {
        const entry = byItem.get(r.item_name) ?? { item: r.item_name, total: 0, unit: r.base_unit, batches: [] };
        const quantity = Number(r.quantity);
        entry.total += quantity;
        entry.batches.push({
          batch_id: r.batch_id,
          quantity,
          date_label: dateLabel(r, today),
          priority_source: r.priority_source,
        });
        byItem.set(r.item_name, entry);
      }
      const items = [...byItem.values()];
      const text =
        items.length === 0
          ? item
            ? `No record of ${item} in the pantry.`
            : 'The pantry has no recorded items.'
          : items.map((i) => `${i.item}: ${i.total} ${i.unit}`).join('; ');
      return { content: [{ type: 'text', text }], structuredContent: { today, items } };
    },
  );
}
