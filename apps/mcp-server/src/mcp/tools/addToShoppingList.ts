import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadCatalog, loadConversions } from '../../db/catalog.ts';
import { findSession } from '../../db/sessions.ts';
import { PantryError } from '../../domain/errors.ts';
import { MAX_QUANTITY } from '../../domain/intake.ts';
import { planShoppingLines } from '../../domain/shopping.ts';
import { listAnd } from '../../domain/speech.ts';
import type { ToolContext } from '../context.ts';
import { NameInput } from '../schemas.ts';
import { runWriteTool } from '../toolkit.ts';

const ShoppingItems = z
  .array(
    z.object({
      name: NameInput,
      quantity: z.number().positive().max(MAX_QUANTITY).optional(),
      unit: z.string().trim().min(1).max(20).optional(),
    }),
  )
  .min(1)
  .max(20);

export function registerAddToShoppingList(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'add_to_shopping_list',
    {
      title: 'Add to the shopping list',
      description:
        'Use only when the user asked to add something to the shopping list, or said yes when offered. ' +
        'Each call adds new rows, so call it once per request. Pass session_id when the items are short for that meal.',
      inputSchema: { items: ShoppingItems, session_id: z.uuid().optional() },
      outputSchema: {
        items: z.array(
          z.object({ id: z.string(), item: z.string(), known: z.boolean(), quantity: z.number().nullable(), unit: z.string().nullable() }),
        ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args, extra) =>
      runWriteTool(ctx, { name: 'add_to_shopping_list', args, meta: extra._meta, needsConversation: false }, async (tx) => {
        const householdId = ctx.auth.householdId;
        if (args.session_id !== undefined && !(await findSession(tx, householdId, args.session_id))) {
          throw new PantryError('not_found', 'There is no such cooking session.', { session_id: args.session_id });
        }
        const lines = planShoppingLines(args.items, await loadCatalog(tx, householdId), await loadConversions(tx, householdId));
        const added = [];
        for (const line of lines) {
          const id = randomUUID();
          await tx.query(
            `INSERT INTO pantry.shopping_list_items (id, household_id, item_id, free_text, quantity, unit, source, session_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [id, householdId, line.item_id, line.free_text, line.quantity, line.unit, args.session_id ? 'shortfall' : 'manual', args.session_id ?? null],
          );
          added.push({ id, item: line.name, known: line.item_id !== null, quantity: line.quantity, unit: line.unit });
        }
        return {
          data: { items: added },
          text: `Added ${listAnd(added.map((a) => a.item))} to the shopping list.`,
        };
      }),
  );
}
