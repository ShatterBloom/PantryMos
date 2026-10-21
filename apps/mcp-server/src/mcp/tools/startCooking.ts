import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadCatalog } from '../../db/catalog.ts';
import { loadIngredients, loadRecipes, loadSteps } from '../../db/recipes.ts';
import { availableByItem, itemInfo } from '../../db/sessions.ts';
import type { Tx } from '../../db/tx.ts';
import { analyzeRecipe, requireChoice, requireMakeable } from '../../domain/cooking.ts';
import { PantryError } from '../../domain/errors.ts';
import { type CatalogItem, findItem } from '../../domain/items.ts';
import { resolveRecipe } from '../../domain/recipes.ts';
import type { ToolContext } from '../context.ts';
import { NameInput, StepOut, stepOut } from '../schemas.ts';
import { runWriteTool } from '../toolkit.ts';

export function registerStartCooking(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'start_cooking',
    {
      title: 'Start cooking a recipe',
      description:
        'Use only when the user asked to cook or make a meal (not for ideas); starts the recipe and returns step 1. ' +
        'Pass a substitution only for an ingredient a suggestion or error named, e.g. [{"from_item": "scallion", "to_item": "onion"}]. ' +
        'Errors say what is missing; with several substitute options, ask the user first.',
      inputSchema: {
        recipe_name: NameInput.describe('Recipe name, e.g. "creamy spinach pasta".'),
        servings: z.number().int().min(1).max(12).optional().describe('How many people; defaults to the recipe servings.'),
        substitutions: z
          .array(z.object({ from_item: NameInput, to_item: NameInput, chosen_by_user: z.boolean().optional().describe('true only when the user named this substitute; the bundled app sets it from what the user said.'), }))
          .max(10)
          .optional(),
      },
      outputSchema: {
        session_id: z.string(),
        recipe: z.string(),
        servings: z.number(),
        ...StepOut,
        applied_substitutions: z.array(z.object({ from_item: z.string(), to_item: z.string(), quantity: z.number() })),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args, extra) =>
      runWriteTool(ctx, { name: 'start_cooking', args, meta: extra._meta, needsConversation: true }, async (tx, meta) => {
        const householdId = ctx.auth.householdId;
        await rejectIfCooking(tx, householdId);

        const recipe = resolveRecipe(args.recipe_name, await loadRecipes(tx, householdId));
        const servings = args.servings ?? recipe.servings;
        const catalog = await loadCatalog(tx, householdId);
        const items = await itemInfo(tx, householdId);
        const substitutions = (args.substitutions ?? []).map((s) => ({
          from_item_id: itemIdFor(s.from_item, catalog),
          to_item_id: itemIdFor(s.to_item, catalog),
        }));
        const base = {
          ingredients: await loadIngredients(tx, recipe.id),
          recipeServings: recipe.servings,
          servings,
          available: await availableByItem(tx, householdId),
          items,
        };
        if (substitutions.length > 0) {
          // What would be needed without them: an ingredient with several options is the user's pick.
          const needed = analyzeRecipe({ ...base, substitutions: [] }).substitutions_needed;
          substitutions.forEach((s, i) => {
            const need = needed.find((n) => n.from_item_id === s.from_item_id);
            const names = (need?.options ?? []).map((o) => items.get(o.to_item_id)!.name);
            requireChoice(items.get(s.from_item_id)!.name, names, args.substitutions![i]!.chosen_by_user);
          });
        }
        const analysis = analyzeRecipe({ ...base, substitutions });
        const plannedUsage = requireMakeable(analysis, items);
        const steps = await loadSteps(tx, recipe.id);

        const sessionId = randomUUID();
        await tx.query('SAVEPOINT start_session');
        try {
          await tx.query(
            `INSERT INTO pantry.cooking_sessions
               (id, household_id, conversation_id, recipe_id, servings, state, total_steps, current_step, planned_usage)
             VALUES ($1, $2, $3, $4, $5, 'cooking', $6, 1, $7)`,
            [sessionId, householdId, meta.conversationId, recipe.id, servings, steps.length, JSON.stringify(plannedUsage)],
          );
        } catch (err) {
          // A concurrent start in another conversation won the one-active-session index (I6).
          if ((err as { constraint?: string }).constraint !== 'one_active_session') throw err;
          await tx.query('ROLLBACK TO SAVEPOINT start_session');
          await rejectIfCooking(tx, householdId);
          throw err;
        }

        const applied = plannedUsage
          .filter((l) => l.origin === 'substitute')
          .map((l) => ({
            from_item: items.get(l.replaces_item_id!)!.name,
            to_item: items.get(l.item_id)!.name,
            quantity: l.quantity,
          }));
        const first = steps[0]!;
        return {
          data: { session_id: sessionId, recipe: recipe.name, servings, ...stepOut(first, steps.length), applied_substitutions: applied },
          text: `Started ${recipe.name} for ${servings}. Step 1 of ${steps.length}: ${first.text}`,
        };
      }),
  );
}

/** Only one active session per household (I6); the user decides what happens to the current one. */
async function rejectIfCooking(tx: Tx, householdId: string): Promise<void> {
  const { rows } = await tx.query<{ id: string; recipe: string; current_step: number; total_steps: number }>(
    `SELECT s.id, r.name AS recipe, s.current_step, s.total_steps
       FROM pantry.cooking_sessions s JOIN pantry.recipes r ON r.id = s.recipe_id
      WHERE s.household_id = $1 AND s.state IN ('cooking', 'awaiting_confirmation')`,
    [householdId],
  );
  const active = rows[0];
  if (active) {
    throw new PantryError(
      'session_in_progress',
      `${active.recipe} is already in progress (step ${active.current_step} of ${active.total_steps}).`,
      {
        ask: `Cancel ${active.recipe}, or keep going with it?`,
        options: ['cancel the current recipe', 'keep going'],
        session_id: active.id,
      },
    );
  }
}

function itemIdFor(spoken: string, catalog: readonly CatalogItem[]): string {
  const item = findItem(spoken, catalog);
  if (!item) throw new PantryError('invalid_substitution', `There is no ${spoken} in the catalog.`, { item: spoken });
  return item.id;
}
