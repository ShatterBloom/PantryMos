import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadSteps } from '../../db/recipes.ts';
import { lockActiveSession } from '../../db/sessions.ts';
import { PantryError } from '../../domain/errors.ts';
import type { ToolContext } from '../context.ts';
import { StepOut, stepOut } from '../schemas.ts';
import { runWriteTool } from '../toolkit.ts';

export function registerNextStep(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'next_step',
    {
      title: 'Next recipe step',
      description:
        'Use only when the user says "next": advances exactly one step. Never call it on your own or after a timer. ' +
        'expected_step is the step the user last heard; if the session moved on, the current step is returned as step_conflict ' +
        'and should be read to the user. At the last step it returns done: true without advancing.',
      inputSchema: {
        session_id: z.uuid().optional(),
        expected_step: z.number().int().min(1).describe('The step number the user last heard.'),
      },
      outputSchema: { session_id: z.string(), ...StepOut, done: z.boolean(), ask: z.string().nullable() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args, extra) =>
      runWriteTool(ctx, { name: 'next_step', args, meta: extra._meta, needsConversation: false }, async (tx) => {
        // The row lock serializes concurrent "next" requests (R32): only one sees its expected step.
        const session = await lockActiveSession(tx, ctx.auth.householdId, args.session_id);
        const steps = await loadSteps(tx, session.recipe_id);
        const current = steps[session.current_step - 1]!;

        if (session.state !== 'cooking') {
          throw new PantryError('invalid_state', 'The recipe is finished; the card with what you used is waiting.', {
            state: session.state,
          });
        }
        if (session.current_step !== args.expected_step) {
          throw new PantryError('step_conflict', `The recipe is on step ${session.current_step}, not ${args.expected_step}.`, {
            current_step: session.current_step,
            step_text: current.text,
          });
        }
        if (session.current_step === session.total_steps) {
          const ask = "That was the last step. Tell me when you're done.";
          return { data: { session_id: session.id, ...stepOut(current, session.total_steps), done: true, ask }, text: ask };
        }

        const next = steps[session.current_step]!;
        await tx.query(`UPDATE pantry.cooking_sessions SET current_step = $2 WHERE id = $1`, [session.id, next.step_no]);
        return {
          data: { session_id: session.id, ...stepOut(next, session.total_steps), done: false, ask: null },
          text: `Step ${next.step_no} of ${session.total_steps}: ${next.text}`,
        };
      }),
  );
}
