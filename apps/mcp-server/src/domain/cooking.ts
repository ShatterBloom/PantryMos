// Recipe makeability and the session's planned usage (IMPLEMENTATION_PLAN §6.3, §7.4 start_cooking).
// One analysis serves suggest_recipes and start_cooking, so a recipe recommended as makeable always starts.
import { PantryError } from './errors.ts';
import type { BaseUnit } from './items.ts';
import { type Ingredient, scaleQuantity } from './recipes.ts';
import { formatNumber, listOr } from './speech.ts';

/** One line of `cooking_sessions.planned_usage`. */
export interface PlannedLine {
  item_id: string;
  quantity: number;
  status: 'planned' | 'skipped';
  origin: 'recipe' | 'substitute';
  replaces_item_id?: string;
}

export interface ItemInfo {
  name: string;
  base_unit: BaseUnit;
}

export interface SubstitutionOption {
  to_item_id: string;
  quantity: number;
}

export interface Analysis {
  lines: PlannedLine[];
  /** Short non-optional ingredients that in-stock author-defined substitutes could cover. */
  substitutions_needed: Array<{ from_item_id: string; options: SubstitutionOption[] }>;
  /** Short items nothing in stock can cover. Empty means makeable (possibly after substitutions). */
  shortfall: Array<{ item_id: string; need: number; have: number }>;
}

export interface AnalysisInput {
  ingredients: readonly Ingredient[];
  recipeServings: number;
  servings: number;
  /** Active stock per item id, in base units. */
  available: ReadonlyMap<string, number>;
  /** Chosen substitutions, by item id. */
  substitutions: ReadonlyArray<{ from_item_id: string; to_item_id: string }>;
  items: ReadonlyMap<string, ItemInfo>;
}

/**
 * Plans usage for `servings` and checks it against stock (§6.3): every non-optional ingredient must be
 * covered directly or via an author-defined substitute. Short optional ingredients are skipped.
 * Throws `invalid_substitution` for a substitution the recipe doesn't allow.
 */
export function analyzeRecipe(input: AnalysisInput): Analysis {
  const { ingredients, recipeServings, servings, available, items } = input;
  const nameOf = (id: string) => items.get(id)?.name ?? id;
  const chosen = new Map(input.substitutions.map((s) => [s.from_item_id, s.to_item_id]));

  for (const [from, to] of chosen) {
    const ingredient = ingredients.find((i) => i.item_id === from);
    if (!ingredient) {
      throw new PantryError('invalid_substitution', `This recipe doesn't use ${nameOf(from)}.`, { from_item: nameOf(from) });
    }
    if (!ingredient.substitutes.some((s) => s.item_id === to)) {
      const allowed = ingredient.substitutes.map((s) => nameOf(s.item_id));
      throw new PantryError('invalid_substitution', `This recipe doesn't allow ${nameOf(to)} instead of ${nameOf(from)}.`, {
        from_item: nameOf(from),
        options: allowed,
      });
    }
  }

  const scaled = (quantity: number, itemId: string) =>
    scaleQuantity(quantity, items.get(itemId)?.base_unit ?? 'g', recipeServings, servings);

  const lines: PlannedLine[] = [];
  for (const ing of ingredients) {
    const to = chosen.get(ing.item_id);
    if (to === undefined) {
      lines.push({ item_id: ing.item_id, quantity: scaled(ing.quantity, ing.item_id), status: 'planned', origin: 'recipe' });
      continue;
    }
    const ratio = ing.substitutes.find((s) => s.item_id === to)!.ratio;
    lines.push({ item_id: ing.item_id, quantity: scaled(ing.quantity, ing.item_id), status: 'skipped', origin: 'recipe' });
    lines.push({
      item_id: to,
      quantity: scaled(ing.quantity * ratio, to),
      status: 'planned',
      origin: 'substitute',
      replaces_item_id: ing.item_id,
    });
  }

  // Optional ingredients the stock can't cover are left out rather than blocking the recipe.
  const demand = () => demandByItem(lines);
  for (const line of lines) {
    const optional = line.origin === 'recipe' && ingredients.find((i) => i.item_id === line.item_id)?.optional;
    if (optional && line.status === 'planned' && (demand().get(line.item_id) ?? 0) > (available.get(line.item_id) ?? 0)) {
      line.status = 'skipped';
    }
  }

  const substitutions_needed: Analysis['substitutions_needed'] = [];
  const shortfall: Analysis['shortfall'] = [];
  const totals = demand();
  for (const [itemId, need] of totals) {
    const have = available.get(itemId) ?? 0;
    if (need <= have) continue;
    const ingredient = ingredients.find((i) => i.item_id === itemId && !i.optional);
    const replaceable = ingredient !== undefined && !chosen.has(itemId);
    const options = replaceable
      ? ingredient.substitutes
          .map((s) => ({ to_item_id: s.item_id, quantity: scaled(ingredient.quantity * s.ratio, s.item_id) }))
          .filter((o) => o.quantity + (totals.get(o.to_item_id) ?? 0) <= (available.get(o.to_item_id) ?? 0))
      : [];
    if (options.length > 0) substitutions_needed.push({ from_item_id: itemId, options });
    else shortfall.push({ item_id: itemId, need, have });
  }
  return { lines, substitutions_needed, shortfall };
}

/**
 * Turns an analysis into the start_cooking decision: the planned lines, or the business error that
 * says what's missing. A needed substitution is never chosen here; the caller must pass it.
 */
export function requireMakeable(analysis: Analysis, items: ReadonlyMap<string, ItemInfo>): PlannedLine[] {
  const nameOf = (id: string) => items.get(id)?.name ?? id;
  const unitOf = (id: string) => items.get(id)?.base_unit ?? '';
  if (analysis.shortfall.length > 0) {
    const shortfall = analysis.shortfall.map((s) => ({
      item: nameOf(s.item_id),
      need: s.need,
      have: s.have,
      unit: unitOf(s.item_id),
    }));
    throw new PantryError(
      'insufficient_stock',
      `Not enough ${listOr(shortfall.map((s) => s.item))} for this recipe: ${shortfall
        .map((s) => `${s.item} needs ${formatNumber(s.need)} ${s.unit}, have ${formatNumber(s.have)}`)
        .join('; ')}.`,
      { shortfall, options: ['make fewer servings', 'add the missing items to the shopping list', 'pick another recipe'] },
    );
  }
  const first = analysis.substitutions_needed[0];
  if (first) {
    const options = first.options.map((o) => nameOf(o.to_item_id));
    throw new PantryError('substitution_required', `There isn't enough ${nameOf(first.from_item_id)}.`, {
      from_item: nameOf(first.from_item_id),
      options,
      ask: `Use ${listOr(options)} instead of ${nameOf(first.from_item_id)}?`,
    });
  }
  return analysis.lines;
}

export function demandByItem(lines: readonly PlannedLine[]): Map<string, number> {
  const demand = new Map<string, number>();
  for (const line of lines) {
    if (line.status === 'planned') demand.set(line.item_id, (demand.get(line.item_id) ?? 0) + line.quantity);
  }
  return demand;
}

/** The plan without the recipe line for `fromItemId` and any substitute standing in for it. */
function withoutIngredient(plan: readonly PlannedLine[], fromItemId: string): PlannedLine[] {
  return plan.filter(
    (l) => !(l.origin === 'recipe' && l.item_id === fromItemId) && l.replaces_item_id !== fromItemId,
  );
}

/**
 * In-stock substitutes for one ingredient of an active plan (§7.4 substitute without to_item):
 * author-defined, scaled to the session's servings, and covered by stock after the rest of the plan.
 */
export function substituteOptions(
  plan: readonly PlannedLine[],
  ingredient: Ingredient,
  scale: (quantity: number, itemId: string) => number,
  available: ReadonlyMap<string, number>,
): SubstitutionOption[] {
  const otherDemand = demandByItem(withoutIngredient(plan, ingredient.item_id));
  return ingredient.substitutes
    .map((s) => ({ to_item_id: s.item_id, quantity: scale(ingredient.quantity * s.ratio, s.item_id) }))
    .filter((o) => o.quantity + (otherDemand.get(o.to_item_id) ?? 0) <= (available.get(o.to_item_id) ?? 0));
}

/**
 * Replaces an ingredient with a substitute in the plan: the recipe line becomes skipped, any earlier
 * substitute for it is dropped, and the new substitute line follows the recipe line.
 */
export function applySubstitute(
  plan: readonly PlannedLine[],
  fromItemId: string,
  option: SubstitutionOption,
): PlannedLine[] {
  const result: PlannedLine[] = [];
  for (const line of plan) {
    if (line.replaces_item_id === fromItemId) continue;
    if (line.origin === 'recipe' && line.item_id === fromItemId) {
      result.push({ ...line, status: 'skipped' });
      result.push({
        item_id: option.to_item_id,
        quantity: option.quantity,
        status: 'planned',
        origin: 'substitute',
        replaces_item_id: fromItemId,
      });
    } else {
      result.push(line);
    }
  }
  return result;
}

/** Marks every planned line of an item as skipped. */
export function skipItem(plan: readonly PlannedLine[], itemId: string): PlannedLine[] {
  return plan.map((l) => (l.item_id === itemId && l.status === 'planned' ? { ...l, status: 'skipped' } : l));
}
