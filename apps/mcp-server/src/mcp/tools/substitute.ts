import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadCatalog } from '../../db/catalog.ts';
import { loadIngredients, loadRecipe } from '../../db/recipes.ts';
import { availableByItem, itemInfo, lockActiveSession, updatePlan } from '../../db/sessions.ts';
import { applySubstitute, requireChoice, substituteOptions } from '../../domain/cooking.ts';
import { PantryError } from '../../domain/errors.ts';
import { findItem } from '../../domain/items.ts';
import { scaleQuantity } from '../../domain/recipes.ts';
import { listOr } from '../../domain/speech.ts';
import type { ToolContext } from '../context.ts';
import { NameInput } from '../schemas.ts';
import { UsageLineOut, usageLines } from '../sessionView.ts';
import { runWriteTool } from '../toolkit.ts';

export function registerSubstitute(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'substitute',
    {
      title: 'Substitute an ingredient',
      description:
        'Use when the user is out of an ingredient mid-cook ("I\'m out of scallions"). Without to_item, lists the in-stock ' +
        'substitutes the recipe allows; with to_item, changes the plan. Changes only the planned usage, never inventory. ' +
        'With several options, ask the user which one.',
      inputSchema: {
        from_item: NameInput.describe('The ingredient to replace, e.g. "scallions".'),
        to_item: NameInput.optional().describe('The substitute the user chose, e.g. "onion".'),
        chosen_by_user: z.boolean().optional().describe('true only when the user named this substitute; the bundled app sets it from what the user said.'),
        session_id: z.uuid().optional(),
      },
      outputSchema: {
        session_id: z.string(),
        changed: z.boolean(),
        options: z.array(z.object({ item: z.string(), quantity: z.number(), unit: z.string() })),
        planned_usage: z.array(UsageLineOut),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      runWriteTool(ctx, { name: 'substitute', args, meta: extra._meta, needsConversation: false }, async (tx) => {
        const householdId = ctx.auth.householdId;
        const session = await lockActiveSession(tx, householdId, args.session_id);
        const recipe = await loadRecipe(tx, session.recipe_id);
        const items = await itemInfo(tx, householdId);
        const catalog = await loadCatalog(tx, householdId);

        const from = findItem(args.from_item, catalog);
        const ingredient = (await loadIngredients(tx, recipe.id)).find((i) => i.item_id === from?.id);
        if (!from || !ingredient) {
          throw new PantryError('not_in_plan', `${recipe.name} doesn't use ${args.from_item}.`, { item: args.from_item });
        }

        const scale = (quantity: number, itemId: string) =>
          scaleQuantity(quantity, items.get(itemId)!.base_unit, recipe.servings, session.servings);
        const options = substituteOptions(session.planned_usage, ingredient, scale, await availableByItem(tx, householdId));
        const optionsOut = options.map((o) => ({
          item: items.get(o.to_item_id)!.name,
          quantity: o.quantity,
          unit: items.get(o.to_item_id)!.base_unit,
        }));

        if (args.to_item === undefined) {
          if (options.length === 0) {
            throw new PantryError('no_substitute', `There is no substitute for ${from.name} in stock.`, {
              ask: `Skip the ${from.name}, or add it to the shopping list?`,
              options: ['skip it', 'add it to the shopping list'],
            });
          }
          const names = optionsOut.map((o) => o.item);
          return {
            data: { session_id: session.id, changed: false, options: optionsOut, planned_usage: usageLines(session.planned_usage, items) },
            text: `${from.name} can be replaced with ${listOr(names)}.`,
          };
        }

        const to = findItem(args.to_item, catalog);
        if (!to || !ingredient.substitutes.some((s) => s.item_id === to.id)) {
          throw new PantryError('invalid_substitution', `${recipe.name} doesn't allow ${args.to_item} instead of ${from.name}.`, {
            options: ingredient.substitutes.map((s) => items.get(s.item_id)!.name),
          });
        }
        const option = options.find((o) => o.to_item_id === to.id);
        if (!option) {
          throw new PantryError('insufficient_stock', `There isn't enough ${to.name} to replace the ${from.name}.`, {
            item: to.name,
            options: optionsOut.map((o) => o.item),
          });
        }

        requireChoice(from.name, optionsOut.map((o) => o.item), args.chosen_by_user);
        const plan = applySubstitute(session.planned_usage, from.id, option);
        const changed = await updatePlan(tx, session, plan);
        return {
          data: { session_id: session.id, changed, options: optionsOut, planned_usage: usageLines(plan, items) },
          text: `Using ${optionsOut.find((o) => o.item === to.name)!.quantity} ${to.name} instead of ${from.name}; inventory is unchanged.`,
        };
      }),
  );
}
