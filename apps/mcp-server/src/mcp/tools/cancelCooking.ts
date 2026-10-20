import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { lockActiveSession, supersedePendingConsume } from '../../db/sessions.ts';
import type { ToolContext } from '../context.ts';
import { runWriteTool } from '../toolkit.ts';

export function registerCancelCooking(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'cancel_cooking',
    {
      title: 'Cancel cooking',
      description:
        'Use only when the user explicitly asks to stop or cancel the recipe. Discards the plan and any waiting ' +
        'consumption card; inventory is unchanged.',
      inputSchema: { session_id: z.uuid().optional() },
      outputSchema: { session_id: z.string(), recipe: z.string(), state: z.literal('cancelled') },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args, extra) =>
      runWriteTool(ctx, { name: 'cancel_cooking', args, meta: extra._meta, needsConversation: false }, async (tx) => {
        const session = await lockActiveSession(tx, ctx.auth.householdId, args.session_id);
        await tx.query(
          `UPDATE pantry.cooking_sessions
              SET state = 'cancelled', ended_at = now(), state_version = state_version + 1
            WHERE id = $1`,
          [session.id],
        );
        await supersedePendingConsume(tx, session.id);
        return {
          data: { session_id: session.id, recipe: session.recipe, state: 'cancelled' },
          text: `Cancelled ${session.recipe}; inventory is unchanged.`,
        };
      }),
  );
}
