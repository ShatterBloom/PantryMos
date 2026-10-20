// Usage revisions (IMPLEMENTATION_PLAN §4.2, §6.5): "I actually used 3 eggs" after a meal was recorded.
import { z } from 'zod';
import { householdToday, loadCatalog, type Queryable } from '../db/catalog.ts';
import { activeBatches, batchesByIds, type BatchView } from '../db/inventory.ts';
import { type ProposalRef, upsertProposal } from '../db/proposals.ts';
import { loadRecipes } from '../db/recipes.ts';
import { effectiveUsage, itemInfo, lockConsumedSession, recentMeals, type SessionRow, sourceBatches } from '../db/sessions.ts';
import type { Tx } from '../db/tx.ts';
import { type AllocationLine, allocateFefo, allocateReturn } from '../domain/allocation.ts';
import { type Card, CONFIRM_PROMPT } from '../domain/card.ts';
import { PantryError } from '../domain/errors.ts';
import { MAX_QUANTITY } from '../domain/intake.ts';
import { type BaseUnit, findItem } from '../domain/items.ts';
import { resolveRecipe } from '../domain/recipes.ts';
import { type RevisionLine, revisionLines } from '../domain/revision.ts';
import { formatNumber, listAnd, speakQuantity } from '../domain/speech.ts';
import { NameInput } from '../mcp/schemas.ts';
import { normalizeOverride } from './consume.ts';

/** New totals for some items of the meal, in base units; unlisted items stay as they are. */
export const RevisionUsage = z
  .array(z.object({ item: NameInput, quantity: z.number().min(0).max(MAX_QUANTITY).describe('Base units') }))
  .min(1)
  .max(20);

export interface ReviseInput {
  usage: Array<{ item: string; quantity: number }>;
  session_id?: string | undefined;
  recipe_name?: string | undefined;
}

export interface ReviseLine extends RevisionLine {
  item: string;
  unit: BaseUnit;
}

export interface RevisePayload {
  lines: ReviseLine[];
  allocation: AllocationLine[];
  card: Card;
}

export interface RevisePreconditions {
  session: { id: string; state: 'consumed'; state_version: number };
  /** Every batch the allocation touches, with the version it was planned against. */
  batches: Array<{ id: string; version: number }>;
}

export const reviseSubject = (sessionId: string) => `revise:session:${sessionId}`;

/**
 * Proposes new usage totals for a finished meal (§7.4 propose_consumption_revision). Diffs are
 * taken against the meal's effective usage (I5); more is taken FEFO, less goes back to the batches
 * the meal took it from. Inventory is unchanged until the card is confirmed.
 */
export async function proposeRevision(
  tx: Tx,
  householdId: string,
  conversationId: string,
  input: ReviseInput,
): Promise<ProposalRef & { card: Card; session_id: string }> {
  const sessionId = input.session_id ?? (await resolveMeal(tx, householdId, input.recipe_name));
  const session = await lockConsumedSession(tx, householdId, sessionId);
  const usage = input.usage.map(normalizeOverride);
  const plan = await planRevision(tx, session, usage);
  const preconditions: RevisePreconditions = {
    session: { id: session.id, state: 'consumed', state_version: session.state_version },
    batches: plan.batches.map((b) => ({ id: b.batch_id, version: b.version })),
  };
  const ref = await upsertProposal(tx, householdId, {
    kind: 'revise_consumption',
    subjectKey: reviseSubject(session.id),
    conversationId,
    targetSessionId: session.id,
    // Edits and Refresh re-plan this exact meal, even once it is out of the 24 h window.
    input: { session_id: session.id, usage },
    payload: plan.payload,
    preconditions,
  });
  return { ...ref, card: plan.payload.card, session_id: session.id };
}

/** §6.5: without a session_id, the one meal consumed in the last 24 h (optionally of one recipe). */
async function resolveMeal(q: Queryable, householdId: string, recipeName: string | undefined): Promise<string> {
  let meals = await recentMeals(q, householdId);
  if (recipeName !== undefined) {
    const recipe = resolveRecipe(recipeName, await loadRecipes(q, householdId));
    meals = meals.filter((m) => m.recipe_id === recipe.id);
  }
  if (meals.length === 0) {
    throw new PantryError(
      'no_completed_session',
      recipeName === undefined ? 'No meal was recorded in the last 24 hours.' : `No ${recipeName} was recorded in the last 24 hours.`,
    );
  }
  if (meals.length > 1) {
    const options = meals.map((m) => ({ session_id: m.id, recipe: m.recipe, consumed_at: m.consumed_at.toISOString() }));
    throw new PantryError('ambiguous_session', `More than one meal was recorded recently: ${listAnd(options.map((o) => o.recipe))}.`, {
      ask: 'Which meal do you mean?',
      options,
    });
  }
  return meals[0]!.id;
}

async function planRevision(
  tx: Tx,
  session: SessionRow,
  usage: ReadonlyArray<{ item: string; quantity: number }>,
): Promise<{ payload: RevisePayload; batches: BatchView[] }> {
  const householdId = session.household_id;
  const items = await itemInfo(tx, householdId);
  const nameOf = (id: string) => items.get(id)?.name ?? id;
  const catalog = await loadCatalog(tx, householdId);
  const targets = new Map<string, number>();
  for (const u of usage) {
    const item = findItem(u.item, catalog);
    if (!item) throw new PantryError('unknown_item', `There is no ${u.item} in the catalog.`, { item: u.item });
    targets.set(item.id, u.quantity);
  }

  const diffs = revisionLines(await effectiveUsage(tx, session.id), targets);
  const more = new Map(diffs.filter((l) => l.diff > 0).map((l) => [l.item_id, l.diff]));
  const less = new Map(diffs.filter((l) => l.diff < 0).map((l) => [l.item_id, -l.diff]));

  const today = await householdToday(tx, householdId);
  const fefo = await activeBatches(tx, householdId, today, { itemIds: [...more.keys()] });
  const allocation = [
    ...allocateFefo(more, fefo, nameOf),
    ...allocateReturn(less, await sourceBatches(tx, session.id, [...less.keys()])),
  ];
  const batches = await batchesByIds(tx, householdId, [...new Set(allocation.map((a) => a.batch_id))], today);
  const lines = diffs
    .map((l) => ({ ...l, item: nameOf(l.item_id), unit: items.get(l.item_id)!.base_unit }))
    .sort((a, b) => a.item.localeCompare(b.item));
  return { payload: { lines, allocation, card: renderCard(session.recipe, lines, allocation, batches) }, batches };
}

/** Every item of the meal, then one line per batch that changes (FR-17). */
function renderCard(
  recipe: string,
  lines: readonly ReviseLine[],
  allocation: readonly AllocationLine[],
  batches: readonly BatchView[],
): Card {
  const unit = (l: ReviseLine) => (l.unit === 'count' ? '' : ` ${l.unit}`);
  const itemLines = lines.map((l) =>
    l.status === 'unchanged'
      ? `${l.item}: ${formatNumber(l.current)}${unit(l)} (unchanged)`
      : `${l.item}: ${formatNumber(l.current)} → ${formatNumber(l.target)}${unit(l)} (${l.diff > 0 ? '+' : '−'}${formatNumber(Math.abs(l.diff))})`,
  );
  const batchLines = allocation.map((a) => {
    const batch = batches.find((b) => b.batch_id === a.batch_id)!;
    const amount = speakQuantity(batch.item, Math.abs(a.delta), batch.unit, batch.unit);
    return `${a.delta < 0 ? 'take' : 'put back'} ${amount} · ${batch.date_label}`;
  });
  const changed = lines.filter((l) => l.status === 'changed');
  const spoken = changed.map((l) => `${speakQuantity(l.item, l.target, l.unit, l.unit)} instead of ${formatNumber(l.current)}`);
  return {
    title: `Correct ${recipe}`,
    lines: [...itemLines, ...batchLines],
    warnings: [],
    readback_text:
      changed.length > 0
        ? `For ${recipe}, I'll record ${listAnd(spoken)}. ${CONFIRM_PROMPT}`
        : `That matches what was recorded for ${recipe}, so nothing changes. ${CONFIRM_PROMPT}`,
  };
}
