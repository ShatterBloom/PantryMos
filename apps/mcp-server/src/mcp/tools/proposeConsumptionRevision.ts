import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { proposeRevision, RevisionUsage } from '../../proposals/revise.ts';
import type { ToolContext } from '../context.ts';
import { CardOut, NameInput } from '../schemas.ts';
import { runWriteTool } from '../toolkit.ts';

export function registerProposeConsumptionRevision(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'propose_consumption_revision',
    {
      title: 'Correct what a meal used',
      description:
        'Use when the user corrects a meal that was already recorded, e.g. "actually I used 3 eggs": list only the items ' +
        'that change, with their new totals in base units (0 if none was used). Without session_id it finds the meal ' +
        'recorded in the last 24 hours. Does NOT change inventory: the user must confirm the card in the app.',
      inputSchema: {
        usage: RevisionUsage.describe('New totals, e.g. [{"item": "egg", "quantity": 3}]. Unlisted items stay as recorded.'),
        session_id: z.uuid().optional(),
        recipe_name: NameInput.optional().describe('Which recent meal, when there was more than one.'),
      },
      outputSchema: {
        proposal_id: z.string(),
        version: z.number(),
        kind: z.literal('revise_consumption'),
        session_id: z.string(),
        card: CardOut,
        expires_at: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      runWriteTool(
        ctx,
        { name: 'propose_consumption_revision', args, meta: extra._meta, needsConversation: true },
        async (tx, meta) => {
          const proposed = await proposeRevision(tx, ctx.auth.householdId, meta.conversationId!, args);
          return {
            data: {
              proposal_id: proposed.proposal_id,
              version: proposed.version,
              kind: 'revise_consumption',
              session_id: proposed.session_id,
              card: proposed.card,
              expires_at: proposed.expires_at,
            },
            text: `Correction card v${proposed.version} is ready for the user to confirm; inventory is unchanged until then.`,
          };
        },
      ),
  );
}
