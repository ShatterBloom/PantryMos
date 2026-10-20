// Server-rendered wording for cards and read-backs (PRD FR-3, FR-33): speech comes from data, not the model.
import type { BaseUnit } from './items.ts';
import { plural } from './text.ts';

const MEASURE_WORDS: Record<string, [string, string]> = {
  g: ['gram', 'grams'],
  kg: ['kilogram', 'kilograms'],
  ml: ['milliliter', 'milliliters'],
  l: ['liter', 'liters'],
};

/** 12 → "12", 0.5 → "0.5", 1.2000000000000002 → "1.2". */
export function formatNumber(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

/**
 * A quantity as it is said aloud, in the unit the user used:
 * "12 eggs", "1 egg", "2 dozen eggs", "500 grams of spinach", "1 carton of eggs".
 */
export function speakQuantity(item: string, quantity: number, unit: string, baseUnit: BaseUnit): string {
  const n = formatNumber(quantity);
  const one = quantity === 1;
  if (unit === 'count') return `${n} ${one ? item : plural(item)}`;
  if (unit === 'dozen') return `${n} dozen ${plural(item)}`;
  const measure = MEASURE_WORDS[unit];
  if (measure) return `${n} ${one ? measure[0] : measure[1]} of ${item}`;
  return `${n} ${one ? unit : plural(unit)} of ${baseUnit === 'count' ? plural(item) : item}`;
}

/** "a", "a and b", "a, b and c" */
export function listAnd(parts: readonly string[]): string {
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/** "a", "a or b", "a, b or c" */
export function listOr(parts: readonly string[]): string {
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} or ${parts.at(-1)}`;
}
