// Item resolution (IMPLEMENTATION_PLAN §6.1): exact name → alias → singular/plural, case-insensitive.
import { PantryError } from './errors.ts';
import { listOr } from './speech.ts';
import { levenshtein, normalizeName, singular } from './text.ts';

export type BaseUnit = 'count' | 'g' | 'ml';
export const BASE_UNITS: readonly BaseUnit[] = ['count', 'g', 'ml'];
export const CATEGORIES = ['produce', 'dairy', 'meat', 'seafood', 'pantry', 'frozen', 'bakery', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface CatalogItem {
  id: string;
  name: string;
  aliases: readonly string[];
  base_unit: BaseUnit;
  category: Category;
  default_shelf_days: number | null;
}

export type Resolution =
  | { kind: 'found'; item: CatalogItem }
  | { kind: 'ambiguous'; options: CatalogItem[] }
  | { kind: 'unknown'; suggestions: string[] };

const MAX_SUGGESTIONS = 5;

export function resolveItem(rawName: string, catalog: readonly CatalogItem[]): Resolution {
  const name = normalizeName(rawName);
  const stages: Array<(item: CatalogItem) => boolean> = [
    (item) => normalizeName(item.name) === name,
    (item) => item.aliases.some((a) => normalizeName(a) === name),
    (item) => namesOf(item).some((n) => singular(n) === singular(name)),
  ];
  for (const matches of stages) {
    const found = catalog.filter(matches);
    if (found.length === 1) return { kind: 'found', item: found[0]! };
    if (found.length > 1) return { kind: 'ambiguous', options: found };
  }
  return { kind: 'unknown', suggestions: suggest(name, catalog) };
}

function namesOf(item: CatalogItem): string[] {
  return [item.name, ...item.aliases].map(normalizeName);
}

/** Close names for "did you mean": shared words or a small edit distance. */
function suggest(name: string, catalog: readonly CatalogItem[]): string[] {
  const words = new Set(name.split(' ').map(singular));
  return catalog
    .map((item) => {
      const distance = Math.min(
        ...namesOf(item).map((n) =>
          n.split(' ').some((w) => words.has(singular(w))) ? 0 : levenshtein(singular(n), singular(name)),
        ),
      );
      return { name: item.name, distance };
    })
    .filter((s) => s.distance <= 2)
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
    .slice(0, MAX_SUGGESTIONS)
    .map((s) => s.name);
}

export function ambiguousItemError(spoken: string, options: readonly CatalogItem[]): PantryError {
  const names = options.map((o) => o.name);
  return new PantryError('ambiguous_item', `"${spoken}" matches more than one item.`, {
    ask: `Which one do you mean: ${listOr(names)}?`,
    options: names,
  });
}
