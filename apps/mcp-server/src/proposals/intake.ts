// Intake proposals: plan the card from the stored input and upsert it (§4.1, §4.2).
import { z } from 'zod';
import { householdToday, loadCatalog, loadConversions } from '../db/catalog.ts';
import { type ProposalRef, upsertProposal } from '../db/proposals.ts';
import type { Tx } from '../db/tx.ts';
import type { Card } from '../domain/card.ts';
import { MAX_QUANTITY, planIntake } from '../domain/intake.ts';
import { CATEGORIES } from '../domain/items.ts';
import { NameInput } from '../mcp/schemas.ts';

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');
const Quantity = z.number().positive().max(MAX_QUANTITY);
const UnitInput = NameInput.max(20);

/** One purchase line, as the model sends it to propose_intake and the app sends it in a card edit. */
export const IntakeItem = z.object({
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

export const IntakeItems = z.array(IntakeItem).min(1).max(20);

export interface IntakeInput {
  items: Array<z.infer<typeof IntakeItem>>;
}

export async function proposeIntake(
  tx: Tx,
  householdId: string,
  conversationId: string,
  input: IntakeInput,
): Promise<ProposalRef & { card: Card }> {
  const { payload, preconditions } = planIntake(input.items, {
    catalog: await loadCatalog(tx, householdId),
    conversions: await loadConversions(tx, householdId),
    today: await householdToday(tx, householdId),
  });
  const ref = await upsertProposal(tx, householdId, {
    kind: 'intake',
    subjectKey: `intake:conv:${conversationId}`,
    conversationId,
    input,
    payload,
    preconditions,
  });
  return { ...ref, card: payload.card };
}
