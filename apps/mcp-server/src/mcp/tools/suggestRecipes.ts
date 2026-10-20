import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { householdToday, loadCatalog } from '../../db/catalog.ts';
import { activeBatches } from '../../db/inventory.ts';
import { loadIngredients, loadRecipes } from '../../db/recipes.ts';
import { availableByItem, itemInfo } from '../../db/sessions.ts';
import { analyzeRecipe } from '../../domain/cooking.ts';
import { findItem } from '../../domain/items.ts';
import { rankRecipe } from '../../domain/recommend.ts';
import { listAnd } from '../../domain/speech.ts';
import type { ToolContext } from '../context.ts';
import { NameInput } from '../schemas.ts';
import { runReadTool } from '../toolkit.ts';

const RecipeOut = z.object({
  recipe_id: z.string(),
  name: z.string(),
  servings: z.number(),
  makeable: z.boolean(),
  score: z.number(),
  reason: z.array(z.object({ item: z.string(), batch_id: z.string(), date_label: z.string() })),
  shortfall: z.array(z.object({ item: z.string(), need: z.number(), have: z.number(), unit: z.string() })),
  substitutions_needed: z.array(
    z.object({
      from_item: z.string(),
      options: z.array(z.object({ to_item: z.string(), quantity: z.number(), in_stock: z.literal(true) })),
    }),
  ),
});

export function registerSuggestRecipes(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'suggest_recipes',
    {
      title: 'Suggest recipes',
      description:
        'Use for "what can I cook?" or before starting a meal: ranks recipes by how many use-first batches they use. ' +
        'Explain a choice with its reason date labels, verbatim. A recipe with one substitute option is makeable with it ' +
        '(pass it to start_cooking); with several, ask the user. Non-makeable recipes list their shortfall.',
      inputSchema: {
        max_results: z.number().int().min(1).max(5).default(3),
        must_use_item: NameInput.optional().describe('Only recipes that use this item, e.g. the top item from expiring_soon.'),
        servings: z.number().int().min(1).max(12).optional().describe("Defaults to each recipe's own servings."),
      },
      outputSchema: { today: z.string(), servings: z.number().nullable(), recipes: z.array(RecipeOut) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ max_results, must_use_item, servings }) =>
      runReadTool(async () => {
        const householdId = ctx.auth.householdId;
        const today = await householdToday(ctx.pool, householdId);
        const items = await itemInfo(ctx.pool, householdId);
        const name = (id: string) => items.get(id)?.name ?? id;
        const available = await availableByItem(ctx.pool, householdId);
        const batches = await activeBatches(ctx.pool, householdId, today);
        const mustUse = must_use_item === undefined ? undefined : findItem(must_use_item, await loadCatalog(ctx.pool, householdId));
        if (must_use_item !== undefined && !mustUse) {
          return { data: { today, servings: servings ?? null, recipes: [] }, text: `There is no ${must_use_item} in the catalog.` };
        }

        const ranked = [];
        for (const recipe of await loadRecipes(ctx.pool, householdId)) {
          const ingredients = await loadIngredients(ctx.pool, recipe.id);
          if (mustUse && !ingredients.some((i) => i.item_id === mustUse.id)) continue;
          const input = { ingredients, recipeServings: recipe.servings, servings: servings ?? recipe.servings, available, items };
          const analysis = analyzeRecipe({ ...input, substitutions: [] });
          // A single in-stock option is what start_cooking would be called with; score that plan.
          const single = analysis.substitutions_needed
            .filter((s) => s.options.length === 1)
            .map((s) => ({ from_item_id: s.from_item_id, to_item_id: s.options[0]!.to_item_id }));
          const planned = single.length > 0 ? analyzeRecipe({ ...input, substitutions: single }) : analysis;
          const rank = rankRecipe(planned, batches, today);
          ranked.push({
            earliest: rank.earliest,
            out: {
              recipe_id: recipe.id,
              name: recipe.name,
              servings: input.servings,
              makeable: analysis.shortfall.length === 0,
              score: rank.score,
              reason: rank.reason,
              shortfall: analysis.shortfall.map((s) => ({ item: name(s.item_id), need: s.need, have: s.have, unit: items.get(s.item_id)!.base_unit })),
              substitutions_needed: analysis.substitutions_needed.map((s) => ({
                from_item: name(s.from_item_id),
                options: s.options.map((o) => ({ to_item: name(o.to_item_id), quantity: o.quantity, in_stock: true as const })),
              })),
            },
          });
        }

        ranked.sort(
          (a, b) =>
            Number(b.out.makeable) - Number(a.out.makeable) ||
            b.out.score - a.out.score ||
            (a.earliest ?? '9999').localeCompare(b.earliest ?? '9999') ||
            a.out.name.localeCompare(b.out.name),
        );
        const recipes = ranked.slice(0, max_results).map((r) => r.out);
        const best = recipes.find((r) => r.makeable);
        const text = best
          ? `Best: ${best.name}, using ${listAnd(best.reason.map((r) => `${r.item} (${r.date_label})`)) || 'what is in stock'}.`
          : recipes.length > 0
            ? `Nothing is makeable right now; ${recipes[0]!.name} is closest.`
            : 'No recipes match.';
        return { data: { today, servings: servings ?? null, recipes }, text };
      }),
  );
}
