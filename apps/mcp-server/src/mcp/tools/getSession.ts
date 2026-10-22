import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadSteps } from '../../db/recipes.ts';
import { availableByItem, effectiveUsage, findSession, itemInfo } from '../../db/sessions.ts';
import { demandByItem, stepWithSubstitutes } from '../../domain/cooking.ts';
import { PantryError } from '../../domain/errors.ts';
import type { ToolContext } from '../context.ts';
import { StepOut, stepOut } from '../schemas.ts';
import { UsageLineOut, usageLines } from '../sessionView.ts';
import { runReadTool } from '../toolkit.ts';

export function registerGetSession(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_session',
    {
      title: 'Get the cooking session',
      description:
        'Use to check the current recipe step, its timer, the planned ingredients and whether stock still covers them. ' +
        'Without session_id: the active session, else the most recent one.',
      inputSchema: { session_id: z.uuid().optional() },
      outputSchema: {
        session_id: z.string(),
        recipe: z.string(),
        servings: z.number(),
        state: z.string(),
        current_step: z.number(),
        ...StepOut,
        planned_usage: z.array(UsageLineOut),
        plan_coverage: z.array(z.object({ item: z.string(), planned: z.number(), available: z.number(), short: z.number() })),
        effective_usage: z.array(z.object({ item: z.string(), quantity: z.number(), unit: z.string() })).nullable(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ session_id }) =>
      runReadTool(async () => {
        const householdId = ctx.auth.householdId;
        const session = await findSession(ctx.pool, householdId, session_id);
        if (!session) throw new PantryError('no_active_session', 'There is no cooking session.');

        const items = await itemInfo(ctx.pool, householdId);
        const name = (id: string) => items.get(id)?.name ?? id;
        const unit = (id: string) => items.get(id)?.base_unit ?? '';
        const steps = await loadSteps(ctx.pool, session.recipe_id);
        const step = steps[session.current_step - 1]!;
        const stepText = stepWithSubstitutes(step.text, session.planned_usage, items);
        const available = await availableByItem(ctx.pool, householdId);

        const coverage = [...demandByItem(session.planned_usage)].map(([itemId, planned]) => {
          const have = available.get(itemId) ?? 0;
          return { item: name(itemId), planned, available: have, short: Math.max(0, planned - have) };
        });
        const finished = session.state === 'consumed' || session.state === 'reverted';
        const effective = finished
          ? [...(await effectiveUsage(ctx.pool, session.id))].map(([itemId, quantity]) => ({
              item: name(itemId),
              quantity,
              unit: unit(itemId),
            }))
          : null;

        return {
          data: {
            session_id: session.id,
            recipe: session.recipe,
            servings: session.servings,
            state: session.state,
            current_step: session.current_step,
            ...stepOut(step, session.total_steps, stepText),
            planned_usage: usageLines(session.planned_usage, items),
            plan_coverage: coverage,
            effective_usage: effective,
          },
          text: `${session.recipe} (${session.state}), step ${session.current_step} of ${session.total_steps}: ${stepText}`,
        };
      }),
  );
}
