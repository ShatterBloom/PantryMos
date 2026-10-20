// Unit resolution (IMPLEMENTATION_PLAN §6.1).
// Accepted without asking: count, g, ml, kg (×1000 g), l (×1000 ml), dozen (×12 count), and saved
// per-item conversions. `dozen` is exact, so it needs no clarification (story B1: "a dozen eggs").
import type { BaseUnit } from './items.ts';
import { normalizeName, singular } from './text.ts';

const BUILTIN = new Map<string, { base: BaseUnit; factor: number }>([
  ['count', { base: 'count', factor: 1 }],
  ['dozen', { base: 'count', factor: 12 }],
  ['g', { base: 'g', factor: 1 }],
  ['kg', { base: 'g', factor: 1000 }],
  ['ml', { base: 'ml', factor: 1 }],
  ['l', { base: 'ml', factor: 1000 }],
]);

/** Spoken spellings of the built-in units. */
const ALIASES = new Map<string, string>([
  ['piece', 'count'], ['pc', 'count'], ['pcs', 'count'], ['each', 'count'], ['unit', 'count'],
  ['gram', 'g'], ['gr', 'g'],
  ['kilogram', 'kg'], ['kilo', 'kg'], ['kgs', 'kg'],
  ['milliliter', 'ml'], ['millilitre', 'ml'], ['mls', 'ml'],
  ['liter', 'l'], ['litre', 'l'], ['ltr', 'l'],
]);

/** Quantities are kept to three decimals of their base unit (0.001 g, ml or count). */
export const roundQuantity = (n: number) => Math.round(n * 1000) / 1000;

/** Saved conversions use this shape (mirrors the `unit_conversions.unit` CHECK). */
export const CONVERSION_UNIT = /^[a-z][a-z ]{0,19}$/;

export function isBuiltinUnit(unit: string): boolean {
  return BUILTIN.has(canonicalUnit(unit));
}

/**
 * Canonical spelling: lowercase, singular, built-in aliases folded.
 * "Cartons" → "carton", "Grams" → "g", "pieces" → "count".
 */
export function canonicalUnit(raw: string): string {
  const unit = normalizeName(raw);
  if (BUILTIN.has(unit)) return unit;
  const one = singular(unit);
  return ALIASES.get(unit) ?? ALIASES.get(one) ?? one;
}

export type UnitResolution =
  | { kind: 'ok'; unit: string; factor: number }
  | { kind: 'mismatch'; unit: string }
  | { kind: 'unknown'; unit: string };

/**
 * How many base units one `rawUnit` is for an item with `baseUnit`.
 * `conversions` maps canonical unit → base quantity (saved or proposed for this item).
 */
export function resolveUnit(
  rawUnit: string,
  baseUnit: BaseUnit,
  conversions: ReadonlyMap<string, number>,
): UnitResolution {
  const unit = canonicalUnit(rawUnit);
  const builtin = BUILTIN.get(unit);
  if (builtin) {
    return builtin.base === baseUnit ? { kind: 'ok', unit, factor: builtin.factor } : { kind: 'mismatch', unit };
  }
  const saved = conversions.get(unit);
  return saved === undefined ? { kind: 'unknown', unit } : { kind: 'ok', unit, factor: saved };
}
