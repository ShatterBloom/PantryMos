// Shopping list lines (IMPLEMENTATION_PLAN §7.4 add_to_shopping_list): catalog items by id, other names as free text.
import { PantryError } from './errors.ts';
import { type CatalogItem, findItem } from './items.ts';
import { roundQuantity, resolveUnit } from './units.ts';

export interface ShoppingInput {
  name: string;
  quantity?: number | undefined;
  unit?: string | undefined;
}

export interface ShoppingLine {
  item_id: string | null;
  free_text: string | null;
  /** The catalog name, or the name as given. */
  name: string;
  quantity: number | null;
  unit: string | null;
}

const NO_CONVERSIONS: ReadonlyMap<string, number> = new Map();

/**
 * Resolves each line (§7.4): a known name is stored as the item, anything else as free text. A
 * quantity needs a unit that is a base unit or a saved conversion of the item; counted items and
 * free text default to a count. A unit without a quantity is refused.
 */
export function planShoppingLines(
  inputs: readonly ShoppingInput[],
  catalog: readonly CatalogItem[],
  conversions: ReadonlyMap<string, ReadonlyMap<string, number>>,
): ShoppingLine[] {
  return inputs.map((input, i) => {
    const path = `items[${i}]`;
    const item = findItem(input.name, catalog);
    const name = item?.name ?? input.name;
    if (input.quantity === undefined) {
      if (input.unit !== undefined) {
        throw new PantryError('needs_clarification', `The quantity of ${name} is missing.`, {
          ask: `How much ${name}?`,
          required: [`${path}.quantity`],
        });
      }
      return { item_id: item?.id ?? null, free_text: item ? null : name, name, quantity: null, unit: null };
    }

    const quantity = roundQuantity(input.quantity);
    if (quantity <= 0) throw new PantryError('invalid_quantity', `${input.quantity} of ${name} is too small to record.`, { field: `${path}.quantity` });
    const baseUnit = item?.base_unit ?? 'count';
    const rawUnit = input.unit ?? (baseUnit === 'count' ? 'count' : undefined);
    if (rawUnit === undefined) {
      throw new PantryError('needs_clarification', `The unit for ${name} is missing.`, {
        ask: `How much ${name}, in grams or milliliters?`,
        required: [`${path}.unit`],
      });
    }
    // Free text has no base unit of its own: any built-in unit fits it.
    const resolved = item
      ? resolveUnit(rawUnit, item.base_unit, conversions.get(item.id) ?? NO_CONVERSIONS)
      : (['count', 'g', 'ml'] as const).map((base) => resolveUnit(rawUnit, base, NO_CONVERSIONS)).find((r) => r.kind === 'ok') ??
        resolveUnit(rawUnit, 'count', NO_CONVERSIONS);
    if (resolved.kind !== 'ok') {
      throw new PantryError('unit_mismatch', `"${resolved.unit}" is not a unit I can use for ${name}.`, {
        ask: `How much ${name}, in a unit like grams, milliliters or a count?`,
        field: `${path}.unit`,
      });
    }
    return { item_id: item?.id ?? null, free_text: item ? null : name, name, quantity, unit: resolved.unit };
  });
}
