// Turning a card edit into the PATCH changes the agent forwards (mcp-server domain/editable.ts).
import type { Editable } from './api.ts';

/**
 * The changes for `edited` amounts, one per editable line (or the one amount), or null when nothing
 * changed. Intake sends every item, dropping lines set to 0; consume and revise send only the
 * changed lines; adjust sends its one field.
 */
export function editChanges(editable: NonNullable<Editable>, edited: readonly number[]): Record<string, unknown> | null {
  switch (editable.type) {
    case 'items': {
      if (editable.lines.every((l, i) => l.quantity === edited[i])) return null;
      const items = editable.items.flatMap((item, i) => (edited[i]! > 0 ? [{ ...item, quantity: edited[i] }] : []));
      return items.length > 0 ? { items } : null;
    }
    case 'lines': {
      const changed = editable.lines.flatMap((l, i) => (l.quantity === edited[i] ? [] : [{ item: l.item, quantity: edited[i]! }]));
      return changed.length > 0 ? { [editable.field]: changed } : null;
    }
    case 'amount':
      return edited[0] === editable.value ? null : { [editable.field]: edited[0] };
  }
}

/** The amounts an edit starts from, in editChanges' order. */
export function editableAmounts(editable: NonNullable<Editable>): number[] {
  return editable.type === 'amount' ? [editable.value] : editable.lines.map((l) => l.quantity);
}

/**
 * What an options card's button says, and what tapping it sends as the user's answer: options are
 * names ("cherry tomato"), suggestions ("make fewer servings"), labelled choices ({label}, e.g. an
 * undo scope) or batches ({date_label}).
 */
export function optionLabel(option: unknown): string | null {
  if (typeof option === 'string') return option;
  if (option && typeof option === 'object') {
    const o = option as Record<string, unknown>;
    if (typeof o.label === 'string') return o.label;
    if (typeof o.date_label === 'string') return o.date_label === 'new batch' ? 'a new batch' : `the one ${o.date_label}`;
    if (typeof o.name === 'string') return o.name;
    if (typeof o.item === 'string') return o.item;
    if (typeof o.to_item === 'string') return o.to_item;
  }
  return null;
}
