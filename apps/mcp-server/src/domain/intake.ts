// Intake planning (IMPLEMENTATION_PLAN §4.2, §6.1, §7.4): turns a spoken purchase list into a pinned
// card, or a business error naming exactly what to ask. Pure: no I/O, no clock (`today` is passed in).
import type { ErrorCode } from '@pantrymos/shared';
import { dateLabel, formatShort, type PackageDateType, validateBatchDates } from './dates.ts';
import { PantryError } from './errors.ts';
import {
  ambiguousItemError,
  type BaseUnit,
  canonicalItemName,
  type CatalogItem,
  type Category,
  resolveItem,
} from './items.ts';
import { priorityOf } from './priority.ts';
import { formatNumber, listAnd, listOr, speakQuantity } from './speech.ts';
import { normalizeName, plural } from './text.ts';
import { canonicalUnit, CONVERSION_UNIT, isBuiltinUnit, resolveUnit } from './units.ts';

/** Largest quantity accepted, in base units (§11.5). */
export const MAX_QUANTITY = 100_000;

export interface IntakeLineInput {
  name: string;
  quantity?: number | undefined;
  unit?: string | undefined;
  purchased_at?: string | undefined;
  opened_at?: string | undefined;
  package_date?: string | undefined;
  package_date_type?: PackageDateType | undefined;
  new_item?: { category: Category; base_unit: BaseUnit; default_shelf_days?: number | undefined } | undefined;
  unit_conversion?: { unit: string; base_qty: number } | undefined;
}

export interface NewItem {
  /** Normalized name; also the key lines and conversions refer to before the item has an id. */
  key: string;
  name: string;
  category: Category;
  base_unit: BaseUnit;
  default_shelf_days: number | null;
}

/** Exactly one of `item_id` (existing item) and `new_item` (a NewItem key) is set. */
export interface ItemRef {
  item_id: string | null;
  new_item: string | null;
}

export interface NewConversion extends ItemRef {
  item: string;
  base_unit: BaseUnit;
  unit: string;
  base_qty: number;
}

export interface IntakeLine extends ItemRef {
  item: string;
  base_unit: BaseUnit;
  quantity_base: number;
  quantity_shown: number;
  unit_shown: string;
  purchased_at: string;
  opened_at: string | null;
  package_date: string | null;
  package_date_type: PackageDateType | null;
  priority_date: string;
  priority_source: 'package' | 'estimate';
  date_label: string;
}

export interface Card {
  title: string;
  lines: string[];
  warnings: string[];
  readback_text: string;
}

export interface IntakePayload {
  lines: IntakeLine[];
  new_items: NewItem[];
  new_conversions: NewConversion[];
  card: Card;
}

export interface IntakePreconditions {
  catalog: {
    /** Normalized names that must still be absent from the catalog at confirm time. */
    absent_items: string[];
    absent_conversions: Array<ItemRef & { unit: string }>;
  };
}

export interface IntakeContext {
  catalog: readonly CatalogItem[];
  /** Saved conversions: item id → canonical unit → base quantity. */
  conversions: ReadonlyMap<string, ReadonlyMap<string, number>>;
  today: string;
}

type Target =
  | { kind: 'existing'; item: CatalogItem }
  | { kind: 'new'; item: NewItem };

/** Plans an intake card, or throws a PantryError describing the first thing to ask (FR-4: never guess). */
export function planIntake(
  items: readonly IntakeLineInput[],
  ctx: IntakeContext,
): { payload: IntakePayload; preconditions: IntakePreconditions } {
  const newItems = new Map<string, NewItem>();
  const newConversions = new Map<string, NewConversion>();
  const lines: IntakeLine[] = [];
  const problems: PantryError[] = [];

  items.forEach((input, index) => {
    try {
      lines.push(planLine(input, `items[${index}]`, ctx, newItems, newConversions));
    } catch (err) {
      if (!(err instanceof PantryError)) throw err;
      problems.push(err);
    }
  });
  if (problems.length > 0) throw firstProblem(problems);

  const payload: IntakePayload = {
    lines,
    new_items: [...newItems.values()],
    new_conversions: [...newConversions.values()],
    card: renderCard(lines, [...newItems.values()], [...newConversions.values()], ctx.today),
  };
  const preconditions: IntakePreconditions = {
    catalog: {
      absent_items: [...newItems.keys()].sort(),
      absent_conversions: [...newConversions.values()]
        .map(({ item_id, new_item, unit }) => ({ item_id, new_item, unit }))
        .sort((a, b) => conversionKey(a).localeCompare(conversionKey(b))),
    },
  };
  return { payload, preconditions };
}

/**
 * One question at a time (FR-2): report the first problem, and list the `required` paths of every
 * line with the same kind of problem, so the model can fill them all on the next call.
 */
function firstProblem(problems: readonly PantryError[]): PantryError {
  const first = problems[0]!;
  const required = problems
    .filter((p) => p.code === first.code)
    .flatMap((p) => p.details.required ?? []);
  return required.length > 0
    ? new PantryError(first.code, first.message, { ...first.details, required })
    : first;
}

function planLine(
  input: IntakeLineInput,
  path: string,
  ctx: IntakeContext,
  newItems: Map<string, NewItem>,
  newConversions: Map<string, NewConversion>,
): IntakeLine {
  const target = resolveTarget(input, path, ctx.catalog, newItems);
  const { name, base_unit } = target.item;
  const ref: ItemRef =
    target.kind === 'existing' ? { item_id: target.item.id, new_item: null } : { item_id: null, new_item: target.item.key };

  if (input.quantity === undefined) {
    throw ask('needs_clarification', `The quantity of ${name} is missing.`, howMuch(name, base_unit), [`${path}.quantity`]);
  }

  // Counting needs no unit ("two tomatoes"); weights and volumes do.
  const rawUnit = input.unit ?? (base_unit === 'count' ? 'count' : undefined);
  if (rawUnit === undefined) {
    throw ask('needs_clarification', `The unit for ${name} is missing.`, howMuch(name, base_unit), [`${path}.unit`]);
  }

  const saved = target.kind === 'existing' ? (ctx.conversions.get(target.item.id) ?? new Map()) : new Map();
  const conversions = new Map<string, number>(saved);
  let offered: string | null = null;
  if (input.unit_conversion) {
    offered = canonicalUnit(input.unit_conversion.unit);
    if (isBuiltinUnit(offered) || !CONVERSION_UNIT.test(offered)) {
      throw new PantryError('unit_mismatch', `"${input.unit_conversion.unit}" is not a package unit that needs a conversion.`, {
        field: `${path}.unit_conversion.unit`,
      });
    }
    conversions.set(offered, input.unit_conversion.base_qty);
  }

  const unit = resolveUnit(rawUnit, base_unit, conversions);
  if (unit.kind === 'mismatch') {
    throw new PantryError('unit_mismatch', `${name} is ${measuredAs(base_unit)}, so "${unit.unit}" does not fit.`, {
      ask: howMuch(name, base_unit),
      field: `${path}.unit`,
    });
  }
  if (unit.kind === 'unknown') {
    throw ask(
      'needs_clarification',
      `I don't know how much ${name} is in a ${unit.unit}.`,
      `How many ${baseNoun(name, base_unit)} are in a ${unit.unit}?`,
      [`${path}.unit_conversion.unit`, `${path}.unit_conversion.base_qty`],
      { unit: unit.unit },
    );
  }
  if (offered === unit.unit && !saved.has(unit.unit)) {
    const conversion: NewConversion = { ...ref, item: name, base_unit, unit: unit.unit, base_qty: unit.factor };
    if (!newConversions.has(conversionKey(conversion))) newConversions.set(conversionKey(conversion), conversion);
  }

  const quantityBase = Math.round(input.quantity * unit.factor * 1000) / 1000;
  if (quantityBase <= 0 || quantityBase > MAX_QUANTITY) {
    throw new PantryError(
      'invalid_quantity',
      `${formatNumber(quantityBase)} ${base_unit} of ${name} is outside the accepted range.`,
      { field: `${path}.quantity` },
    );
  }

  const purchased_at = input.purchased_at ?? ctx.today;
  const opened_at = input.opened_at ?? null;
  const package_date = input.package_date ?? null;
  if (package_date === null && input.package_date_type !== undefined) {
    throw new PantryError('invalid_date', 'A package date type was given without a package date.', {
      field: `${path}.package_date`,
    });
  }
  validateBatchDates({ purchased_at, opened_at, package_date }, ctx.today, path);
  // A date read off the package without saying which kind is shown as "dated …", never as an expiry.
  const package_date_type = package_date === null ? null : (input.package_date_type ?? 'unknown');
  const dates = { purchased_at, opened_at, package_date, package_date_type };

  return {
    ...ref,
    item: name,
    base_unit,
    quantity_base: quantityBase,
    quantity_shown: input.quantity,
    unit_shown: unit.unit,
    ...dates,
    ...priorityOf(dates, target.item.default_shelf_days),
    date_label: dateLabel(dates, ctx.today),
  };
}

function resolveTarget(
  input: IntakeLineInput,
  path: string,
  catalog: readonly CatalogItem[],
  newItems: Map<string, NewItem>,
): Target {
  const known = resolveItem(input.name, catalog);
  if (known.kind === 'found') return { kind: 'existing', item: known.item };
  if (known.kind === 'ambiguous') throw ambiguousItemError(input.name, known.options);

  // Not in the catalog. Earlier lines of this request may already define it ("oat milk" twice).
  const proposed = resolveItem(input.name, [...newItems.values()].map(asCatalogItem));
  if (proposed.kind === 'found') return { kind: 'new', item: newItems.get(proposed.item.id)! };

  if (!input.new_item) {
    const spoken = normalizeName(input.name);
    const guess = known.suggestions.length > 0 ? `Did you mean ${listOr(known.suggestions)}? If not, ` : '';
    throw ask(
      'unknown_item',
      `There is no ${spoken} in the catalog yet.`,
      `${guess}${guess ? 'what' : 'What'} kind of food is ${spoken}, and is it counted, weighed in grams, or measured in milliliters?`,
      [`${path}.new_item.category`, `${path}.new_item.base_unit`],
      { suggestions: known.suggestions },
    );
  }
  const name = canonicalItemName(input.name);
  const item: NewItem = {
    key: name,
    name,
    category: input.new_item.category,
    base_unit: input.new_item.base_unit,
    default_shelf_days: input.new_item.default_shelf_days ?? null,
  };
  newItems.set(item.key, item);
  return { kind: 'new', item };
}

function renderCard(lines: IntakeLine[], newItems: NewItem[], conversions: NewConversion[], today: string): Card {
  const spoken = lines.map((l) => {
    let phrase = speakQuantity(l.item, l.quantity_shown, l.unit_shown, l.base_unit);
    if (l.package_date !== null) phrase += `, ${packagePhrase(l.package_date, l.package_date_type)}`;
    if (l.purchased_at !== today) phrase += `, bought ${formatShort(l.purchased_at)}`;
    return phrase;
  });
  const sentences = [`I'll add ${listAnd(spoken)}.`];
  if (newItems.length > 0) sentences.push(`New ${newItems.length === 1 ? 'item' : 'items'}: ${listAnd(newItems.map((i) => i.name))}.`);
  if (conversions.length > 0) sentences.push(`I'll remember that ${listAnd(conversions.map(conversionPhrase))}.`);
  sentences.push('Say confirm, or tell me what to change.');

  return {
    title: 'Add groceries',
    lines: lines.map((l) => {
      const shown = speakQuantity(l.item, l.quantity_shown, l.unit_shown, l.base_unit);
      const base = l.unit_shown === l.base_unit ? '' : ` (${formatNumber(l.quantity_base)} ${l.base_unit})`;
      return `${shown}${base} · ${l.date_label}`;
    }),
    warnings: [
      ...newItems.map((i) => `New item: ${i.name} · ${i.category} · ${i.base_unit}`),
      ...conversions.map((c) => `Saved: ${conversionPhrase(c)}`),
    ],
    readback_text: sentences.join(' '),
  };
}

function packagePhrase(date: string, type: PackageDateType | null): string {
  const day = formatShort(date);
  if (type === 'use_by') return `use by ${day}`;
  if (type === 'best_by') return `best by ${day}`;
  return `dated ${day}`;
}

/** "1 carton = 12 eggs" */
function conversionPhrase(c: NewConversion): string {
  return `1 ${c.unit} = ${speakQuantity(c.item, c.base_qty, c.base_unit, c.base_unit)}`;
}

function conversionKey(c: ItemRef & { unit: string }): string {
  return `${c.item_id ?? `new:${c.new_item}`}|${c.unit}`;
}

function asCatalogItem(item: NewItem): CatalogItem {
  return { id: item.key, name: item.name, aliases: [], base_unit: item.base_unit, category: item.category, default_shelf_days: item.default_shelf_days };
}

function ask(code: ErrorCode, message: string, question: string, required: string[], extra: Record<string, unknown> = {}): PantryError {
  return new PantryError(code, message, { ask: question, required, ...extra });
}

function howMuch(name: string, base: BaseUnit): string {
  return base === 'count' ? `How many ${plural(name)}?` : `How much ${name}, in ${base === 'g' ? 'grams' : 'milliliters'}?`;
}

function baseNoun(name: string, base: BaseUnit): string {
  if (base === 'count') return plural(name);
  return `${base === 'g' ? 'grams' : 'milliliters'} of ${name}`;
}

function measuredAs(base: BaseUnit): string {
  if (base === 'count') return 'counted';
  return base === 'g' ? 'weighed' : 'measured by volume';
}
