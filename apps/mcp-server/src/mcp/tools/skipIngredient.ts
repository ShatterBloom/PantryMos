import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadCatalog } from '../../db/catalog.ts';
import { loadIngredients } from '../../db/recipes.ts';
import { itemInfo, lockActiveSession, updatePlan } from '../../db/sessions.ts';
import { ingredientCovered, ingredientOf, skipIngredient } from '../../domain/cooking.ts';
import { PantryError } from '../../domain/errors.ts';
import { findItem } from '../../domain/items.ts';
import type { ToolContext } from '../context.ts';
import { NameInput } from '../schemas.ts';
import { UsageLineOut, usageLines } from '../sessionView.ts';
import { runWriteTool } from '../toolkit.ts';

export function registerSkipIngredient(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'skip_ingredient',
    {
      title: 'Skip an ingredient',
      description:
        'Use when the user wants to cook without an ingredient. Optional ingredients are skipped directly; a required one ' +
        'needs confirm_skip: true, which you may set only after the user agreed. Changes the plan, never inventory.',
      inputSchema: {
        item: NameInput.describe('The ingredient to leave out, e.g. "parmesan".'),
        confirm_skip: z.boolean().optional().describe('true only after the user agreed to skip a required ingredient.'),
        session_id: z.uuid().optional(),
      },
      outputSchema: { session_id: z.string(), changed: z.boolean(), planned_usage: z.array(UsageLineOut) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      runWriteTool(ctx, { name: 'skip_ingredient', args, meta: extra._meta, needsConversation: false }, async (tx) => {
        const householdId = ctx.auth.householdId;
        const session = await lockActiveSession(tx, householdId, args.session_id);
        const items = await itemInfo(tx, householdId);
        const item = findItem(args.item, await loadCatalog(tx, householdId));
        const lines = session.planned_usage.filter((l) => l.item_id === item?.id);
        if (!item || lines.length === 0) {
          throw new PantryError('not_in_plan', `This recipe doesn't use ${args.item}.`, { item: args.item });
        }

        // Skipping works on recipe ingredients: "skip the scallions" also drops the onion standing in
        // for them, and skipping that onion means doing without the scallions.
        const ingredientIds = [...new Set(lines.map(ingredientOf))];
        const ingredients = await loadIngredients(tx, session.recipe_id);
        const required = ingredientIds.some(
          (id) => ingredientCovered(session.planned_usage, id) && !ingredients.find((i) => i.item_id === id)?.optional,
        );
        if (required && args.confirm_skip !== true) {
          throw new PantryError('needs_clarification', `${item.name} is needed for this recipe.`, {
            ask: `Cook without the ${item.name} anyway?`,
            required: ['confirm_skip'],
          });
        }

        const plan = ingredientIds.reduce((p, id) => skipIngredient(p, id), session.planned_usage);
        const changed = await updatePlan(tx, session, plan);
        return {
          data: { session_id: session.id, changed, planned_usage: usageLines(plan, items) },
          text: changed ? `Leaving out the ${item.name}; inventory is unchanged.` : `The ${item.name} was already left out.`,
        };
      }),
  );
}
