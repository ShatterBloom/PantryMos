import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { householdToday, loadCatalog } from '../../db/catalog.ts';
import { activeBatches, type BatchView } from '../../db/inventory.ts';
import { ambiguousItemError, resolveItem } from '../../domain/items.ts';
import type { ToolContext } from '../context.ts';
import { NameInput } from '../schemas.ts';
import { runReadTool } from '../toolkit.ts';

const ItemOut = z.object({
  item: z.string(),
  total: z.number(),
  unit: z.string(),
  batches: z.array(
    z.object({
      batch_id: z.string(),
      quantity: z.number(),
      date_label: z.string(),
      priority_source: z.enum(['package', 'estimate']),
    }),
  ),
});

type ItemOut = z.infer<typeof ItemOut>;

export function registerListInventory(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_inventory',
    {
      title: 'List inventory',
      description:
        'Use to answer what is in the kitchen, optionally for one item (e.g. "do I have eggs?"). ' +
        'Answers come only from recorded batches: if an item has no record, say so. ' +
        'Relay each date_label verbatim; never infer expiry dates.',
      inputSchema: {
        item: NameInput.optional().describe('Item name, alias or plural, e.g. "eggs". Omit for everything.'),
      },
      outputSchema: { today: z.string(), items: z.array(ItemOut) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ item }) =>
      runReadTool(async () => {
        const householdId = ctx.auth.householdId;
        const today = await householdToday(ctx.pool, householdId);

        let itemId: string | undefined;
        if (item !== undefined) {
          const resolution = resolveItem(item, await loadCatalog(ctx.pool, householdId));
          if (resolution.kind === 'ambiguous') throw ambiguousItemError(item, resolution.options);
          if (resolution.kind === 'unknown') {
            return { data: { today, items: [] }, text: `There is no record of ${item} in the pantry.` };
          }
          itemId = resolution.item.id;
        }

        const items = groupByItem(await activeBatches(ctx.pool, householdId, today, { itemId }));
        const text =
          items.length > 0
            ? items.map((i) => `${i.item}: ${i.total} ${i.unit}`).join('; ')
            : item !== undefined
              ? `There is no ${item} in stock.`
              : 'The pantry has no recorded items.';
        return { data: { today, items }, text };
      }),
  );
}

/** Items sorted by name; batches keep FEFO order within each item. */
function groupByItem(batches: readonly BatchView[]): ItemOut[] {
  const byItem = new Map<string, ItemOut>();
  for (const b of batches) {
    const entry = byItem.get(b.item_id) ?? { item: b.item, total: 0, unit: b.unit, batches: [] };
    entry.total += b.quantity;
    entry.batches.push({
      batch_id: b.batch_id,
      quantity: b.quantity,
      date_label: b.date_label,
      priority_source: b.priority_source,
    });
    byItem.set(b.item_id, entry);
  }
  return [...byItem.values()].sort((a, b) => a.item.localeCompare(b.item));
}
