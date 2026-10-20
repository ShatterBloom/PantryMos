import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AdjustInputShape, proposeAdjustment } from '../../proposals/adjust.ts';
import type { ToolContext } from '../context.ts';
import { CardOut } from '../schemas.ts';
import { runWriteTool } from '../toolkit.ts';

export function registerProposeAdjustment(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'propose_adjustment',
    {
      title: 'Adjust stock',
      description:
        'Use when the stock differs from the record outside cooking: something was thrown out, a count differs, or more ' +
        'was found. Give exactly one of delta or set_quantity. Not for meals: use propose_consumption_revision. ' +
        'Does NOT change inventory: the user must confirm the card in the app.',
      inputSchema: AdjustInputShape,
      outputSchema: {
        proposal_id: z.string(),
        version: z.number(),
        kind: z.literal('adjust'),
        card: CardOut,
        expires_at: z.string(),
        impact_on_active_session: z.array(
          z.object({ item: z.string(), planned: z.number(), available_after: z.number(), short: z.number() }),
        ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      runWriteTool(ctx, { name: 'propose_adjustment', args, meta: extra._meta, needsConversation: true }, async (tx, meta) => {
        const proposed = await proposeAdjustment(tx, ctx.auth.householdId, meta.conversationId!, args);
        return {
          data: {
            proposal_id: proposed.proposal_id,
            version: proposed.version,
            kind: 'adjust',
            card: proposed.card,
            expires_at: proposed.expires_at,
            impact_on_active_session: proposed.impact_on_active_session,
          },
          text: `Adjustment card v${proposed.version} is ready for the user to confirm; inventory is unchanged until then.`,
        };
      }),
  );
}
