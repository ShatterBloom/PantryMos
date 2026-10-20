// Recipe recommendations (IMPLEMENTATION_PLAN §6.3, PRD FR-9): rank by how many priority batches a
// recipe would use, and explain the ranking with those batches' date labels.
import { allocateFefo } from './allocation.ts';
import { type Analysis, type AnalysisInput, analyzeRecipe, demandByItem } from './cooking.ts';
import { addDays } from './dates.ts';

/** Batches due within this many days count as priority, besides each item's oldest batch. */
export const PRIORITY_WINDOW_DAYS = 3;

export interface RankBatch {
  batch_id: string;
  item_id: string;
  item: string;
  quantity: number;
  version: number;
  priority_date: string;
  date_label: string;
}

export interface Suggestion {
  /** The plan start_cooking gets when passed `substitutions`; score this one. */
  plan: Analysis;
  /** Short ingredients and their in-stock options; a single option is what start_cooking is passed. */
  substitutions: Analysis['substitutions_needed'];
  makeable: boolean;
}

/**
 * What suggest_recipes promises for one recipe: the plan with every single-option substitution
 * applied, and whether that combined plan fits stock. Options are found one ingredient at a time,
 * so two substitutions can each fit alone yet compete for the same stock; makeability is judged on
 * the combined plan, the same check start_cooking makes.
 */
export function suggestRecipe(input: Omit<AnalysisInput, 'substitutions'>): Suggestion {
  const analysis = analyzeRecipe({ ...input, substitutions: [] });
  const single = analysis.substitutions_needed
    .filter((s) => s.options.length === 1)
    .map((s) => ({ from_item_id: s.from_item_id, to_item_id: s.options[0]!.to_item_id }));
  const plan = single.length > 0 ? analyzeRecipe({ ...input, substitutions: single }) : analysis;
  return { plan, substitutions: analysis.substitutions_needed, makeable: plan.shortfall.length === 0 };
}

export interface Ranking {
  score: number;
  reason: Array<{ item: string; batch_id: string; date_label: string }>;
  /** Earliest priority date among the priority batches used; breaks score ties. */
  earliest: string | null;
}

/**
 * Scores a recipe plan against stock. `batches` must be active batches in FEFO order. Lines that
 * stock can't cover are left out of the allocation; single-option substitutions should already be
 * applied to `analysis.lines` by the caller.
 */
export function rankRecipe(analysis: Analysis, batches: readonly RankBatch[], today: string): Ranking {
  const available = new Map<string, number>();
  for (const b of batches) available.set(b.item_id, (available.get(b.item_id) ?? 0) + b.quantity);
  const covered = new Map([...demandByItem(analysis.lines)].filter(([itemId, need]) => need <= (available.get(itemId) ?? 0)));
  const used = new Set(allocateFefo(covered, batches, (id) => id).map((a) => a.batch_id));

  const horizon = addDays(today, PRIORITY_WINDOW_DAYS);
  const oldestOfItem = new Set<string>();
  const seenItems = new Set<string>();
  for (const b of batches) {
    if (!seenItems.has(b.item_id)) oldestOfItem.add(b.batch_id);
    seenItems.add(b.item_id);
  }

  const priority = batches.filter((b) => used.has(b.batch_id) && (b.priority_date <= horizon || oldestOfItem.has(b.batch_id)));
  return {
    score: priority.length,
    reason: priority.map((b) => ({ item: b.item, batch_id: b.batch_id, date_label: b.date_label })),
    earliest: priority.reduce<string | null>((min, b) => (min === null || b.priority_date < min ? b.priority_date : min), null),
  };
}
