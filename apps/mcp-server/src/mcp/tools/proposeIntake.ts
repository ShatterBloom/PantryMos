import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { householdToday, loadCatalog, loadConversions } from '../../db/catalog.ts';
import { upsertProposal } from '../../db/proposals.ts';
import { MAX_QUANTITY, planIntake } from '../../domain/intake.ts';
import { CATEGORIES } from '../../domain/items.ts';
import type { ToolContext } from '../context.ts';
import { NameInput } from '../schemas.ts';
import { runWriteTool } from '../toolkit.ts';

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');
const Quantity = z.number().positive().max(MAX_QUANTITY);
const UnitInput = NameInput.max(20);

const IntakeItem = z.object({
  name: NameInput.describe('What was bought, e.g. "eggs", "oat milk".'),
  quantity: Quantity.optional().describe('How many / how much, in `unit`. Omit if the user did not say; never guess.'),
  unit: UnitInput.optional().describe('"count", "g", "kg", "ml", "l", "dozen", or a package unit like "carton". Omit for counted items.'),
  purchased_at: IsoDate.optional().describe('YYYY-MM-DD; defaults to today. Resolve "yesterday" using `today` from a read tool.'),
  opened_at: IsoDate.optional(),
  package_date: IsoDate.optional().describe('Only a date the user read off the package. Never estimate one.'),
  package_date_type: z.enum(['use_by', 'best_by', 'unknown']).optional(),
  new_item: z
    .object({
      category: z.enum(CATEGORIES),
      base_unit: z.enum(['count', 'g', 'ml']).describe('count for things counted, g for weighed, ml for liquids.'),
      default_shelf_days: z.number().int().min(1).max(3650).optional(),
    })
    .optional()
    .describe('Only after unknown_item, with the answers the user gave.'),
  unit_conversion: z
    .object({ unit: UnitInput, base_qty: Quantity })
    .optional()
    .describe('Only after needs_clarification about a package unit, e.g. {"unit": "carton", "base_qty": 12}.'),
});

const CardOut = z.object({
  title: z.string(),
  lines: z.array(z.string()),
  warnings: z.array(z.string()),
  readback_text: z.string(),
});

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
      inputSchema: { items: z.array(IntakeItem).min(1).max(20) },
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
          const householdId = ctx.auth.householdId;
          const { payload, preconditions } = planIntake(args.items, {
            catalog: await loadCatalog(tx, householdId),
            conversions: await loadConversions(tx, householdId),
            today: await householdToday(tx, householdId),
          });
          const ref = await upsertProposal(tx, householdId, {
            kind: 'intake',
            subjectKey: `intake:conv:${meta.conversationId}`,
            conversationId: meta.conversationId!,
            input: args,
            payload,
            preconditions,
          });
          return {
            data: {
              proposal_id: ref.proposal_id,
              version: ref.version,
              kind: 'intake',
              card: payload.card,
              expires_at: ref.expires_at,
            },
            text: `Intake card v${ref.version} is ready for the user to confirm; inventory is unchanged until then.`,
          };
        },
      ),
  );
}
