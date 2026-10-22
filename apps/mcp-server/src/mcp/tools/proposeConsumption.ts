import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ConsumeOverrides, proposeConsumption } from '../../proposals/consume.ts';
import type { ToolContext } from '../context.ts';
import { CardOut } from '../schemas.ts';
import { runWriteTool } from '../toolkit.ts';

export function registerProposeConsumption(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'propose_consumption',
    {
      title: 'Propose what was used',
      description:
        'Use when the user says they are done cooking, or says "next" on the last step: creates the card of what was ' +
        'used, taken from the oldest batches first. Does NOT change inventory: the user must confirm the card in the app. ' +
        'Use overrides when the user says they used a different amount, e.g. [{"item": "egg", "quantity": 3}]; 0 removes a line. ' +
        'If less of an item is left than the recipe uses, the result asks how much was used: ask the user that, then pass the answer as an override.',
      inputSchema: {
        session_id: z.uuid().optional(),
        overrides: ConsumeOverrides.optional(),
      },
      outputSchema: {
        proposal_id: z.string(),
        version: z.number(),
        kind: z.literal('consume'),
        card: CardOut,
        expires_at: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      runWriteTool(ctx, { name: 'propose_consumption', args, meta: extra._meta, needsConversation: true }, async (tx, meta) => {
        const proposed = await proposeConsumption(tx, ctx.auth.householdId, meta.conversationId!, args);
        return {
          data: {
            proposal_id: proposed.proposal_id,
            version: proposed.version,
            kind: 'consume',
            card: proposed.card,
            expires_at: proposed.expires_at,
          },
          text: `Consumption card v${proposed.version} is ready for the user to confirm; inventory is unchanged until then.`,
        };
      }),
  );
}
