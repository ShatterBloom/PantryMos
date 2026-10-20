import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { IntakeItems, proposeIntake } from '../../proposals/intake.ts';
import type { ToolContext } from '../context.ts';
import { CardOut } from '../schemas.ts';
import { runWriteTool } from '../toolkit.ts';

export function registerProposeIntake(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'propose_intake',
    {
      title: 'Propose groceries to add',
      description:
        'Use when the user says they bought groceries; creates a card listing the batches to add. ' +
        'Does NOT change inventory: the user must confirm the card in the app. ' +
        'If the result asks a question (needs_clarification, unknown_item, ambiguous_item), ask the user exactly that, ' +
        'then call again with the full item list plus the answered fields.',
      inputSchema: { items: IntakeItems },
      outputSchema: {
        proposal_id: z.string(),
        version: z.number(),
        kind: z.literal('intake'),
        card: CardOut,
        expires_at: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      runWriteTool(
        ctx,
        { name: 'propose_intake', args, meta: extra._meta, needsConversation: true },
        async (tx, meta) => {
          const proposed = await proposeIntake(tx, ctx.auth.householdId, meta.conversationId!, args);
          return {
            data: {
              proposal_id: proposed.proposal_id,
              version: proposed.version,
              kind: 'intake',
              card: proposed.card,
              expires_at: proposed.expires_at,
            },
            text: `Intake card v${proposed.version} is ready for the user to confirm; inventory is unchanged until then.`,
          };
        },
      ),
  );
}
