import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { proposeUndo, UndoInputShape } from '../../proposals/undo.ts';
import type { ToolContext } from '../context.ts';
import { CardOut } from '../schemas.ts';
import { runWriteTool } from '../toolkit.ts';

export function registerProposeUndo(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'propose_undo',
    {
      title: 'Undo a change',
      description:
        'Use when the user wants to take back a recorded change ("undo that", "I didn\'t actually cook it"). ' +
        'target "last" is the most recent change; for anything older, get its id from list_recent_operations. ' +
        'If it asks which scope, ask the user. Does NOT change inventory: the user must confirm the card in the app.',
      inputSchema: UndoInputShape,
      outputSchema: {
        proposal_id: z.string(),
        version: z.number(),
        kind: z.literal('undo'),
        scope: z.enum(['operation', 'session']),
        target: z.string(),
        card: CardOut,
        expires_at: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      runWriteTool(ctx, { name: 'propose_undo', args, meta: extra._meta, needsConversation: true }, async (tx, meta) => {
        const proposed = await proposeUndo(tx, ctx.auth.householdId, meta.conversationId!, args);
        return {
          data: {
            proposal_id: proposed.proposal_id,
            version: proposed.version,
            kind: 'undo',
            scope: proposed.scope,
            target: proposed.target,
            card: proposed.card,
            expires_at: proposed.expires_at,
          },
          text: `Undo card v${proposed.version} is ready for the user to confirm; inventory is unchanged until then.`,
        };
      }),
  );
}
