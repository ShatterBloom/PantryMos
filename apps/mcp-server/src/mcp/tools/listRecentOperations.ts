import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { recentOperations } from '../../db/operations.ts';
import { itemInfo } from '../../db/sessions.ts';
import { describeOperation } from '../../domain/operations.ts';
import type { ToolContext } from '../context.ts';
import { runReadTool } from '../toolkit.ts';

export function registerListRecentOperations(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_recent_operations',
    {
      title: 'Recent changes',
      description:
        'Use to see what recently changed the inventory (e.g. "what did I just record?"), or to find the operation_id ' +
        'or session_id to undo. Newest first; reverted ones are marked.',
      inputSchema: { limit: z.number().int().min(1).max(10).default(5) },
      outputSchema: {
        operations: z.array(
          z.object({
            operation_id: z.string(),
            kind: z.enum(['intake', 'consume', 'revise_consumption', 'adjust', 'undo']),
            summary: z.string(),
            changes: z.array(z.object({ item: z.string(), delta: z.number(), unit: z.enum(['count', 'g', 'ml']) })),
            session_id: z.string().nullable(),
            reverted: z.boolean(),
            created_at: z.string(),
          }),
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit }) =>
      runReadTool(async () => {
        const householdId = ctx.auth.householdId;
        const items = await itemInfo(ctx.pool, householdId);
        const operations = (await recentOperations(ctx.pool, householdId, limit)).map((op) => {
          const changes = op.changes.map((c) => ({ item: items.get(c.item_id)!.name, delta: c.delta, unit: items.get(c.item_id)!.base_unit }));
          return {
            operation_id: op.operation_id,
            kind: op.kind,
            summary: describeOperation(op.kind, op.recipe, changes),
            changes,
            session_id: op.session_id,
            reverted: op.reverted,
            created_at: op.created_at.toISOString(),
          };
        });
        // The latest operation is never reverted: an undo is always newer than what it reverts.
        const text = operations[0] ? `Latest: ${operations[0].summary}.` : 'Nothing has been recorded yet.';
        return { data: { operations }, text };
      }),
  );
}
