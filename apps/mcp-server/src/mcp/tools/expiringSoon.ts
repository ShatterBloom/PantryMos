import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { householdToday } from '../../db/catalog.ts';
import { activeBatches } from '../../db/inventory.ts';
import { addDays } from '../../domain/dates.ts';
import type { ToolContext } from '../context.ts';
import { BatchOut } from '../schemas.ts';
import { runReadTool } from '../toolkit.ts';

export function registerExpiringSoon(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'expiring_soon',
    {
      title: 'What to use first',
      description:
        'Use to find what should be used first (e.g. "what should I use first?", "what is about to go bad?"). ' +
        'Returns batches whose priority date falls within the window, earliest first, including overdue ones. ' +
        'Relay each date_label verbatim: an "estimate" priority is not an expiry date.',
      inputSchema: {
        within_days: z.number().int().min(1).max(30).default(3).describe('Days ahead of today to include. Default 3.'),
      },
      outputSchema: { today: z.string(), within_days: z.number(), batches: z.array(BatchOut) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ within_days }) =>
      runReadTool(async () => {
        const householdId = ctx.auth.householdId;
        const today = await householdToday(ctx.pool, householdId);
        const batches = (
          await activeBatches(ctx.pool, householdId, today, { priorityUntil: addDays(today, within_days) })
        ).map(({ item_id: _itemId, version: _version, ...batch }) => batch);
        const text =
          batches.length === 0
            ? `Nothing needs using up in the next ${within_days} days.`
            : `Use first: ${batches.map((b) => `${b.item} (${b.date_label})`).join('; ')}.`;
        return { data: { today, within_days, batches }, text };
      }),
  );
}
