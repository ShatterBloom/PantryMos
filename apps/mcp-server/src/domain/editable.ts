// What the app may edit on a card, and in which shape PATCH /internal/proposals/:id takes it back (§4.4).
import type { ProposalKind } from '../db/proposals.ts';
import type { IntakePayload } from './intake.ts';
import type { IntakeInput } from '../proposals/intake.ts';
import type { AdjustInput, AdjustPayload } from '../proposals/adjust.ts';
import type { ConsumePayload } from '../proposals/consume.ts';
import type { RevisePayload } from '../proposals/revise.ts';

/** A line amount the user can change, in the unit shown. */
export interface EditableLine {
  item: string;
  quantity: number;
  unit: string;
}

/**
 * - `items`: intake. Send `{items}`: the stored items with the edited quantities (a line set to 0 is
 *   left out).
 * - `lines`: consume and revise. Send `{overrides}` (consume) or `{usage}` (revise) with the
 *   changed lines only, in base units.
 * - `amount`: adjust. Send `{[field]: value}`.
 * - null: nothing to edit (undo); Refresh re-plans it.
 */
export type Editable =
  | { type: 'items'; items: IntakeInput['items']; lines: EditableLine[] }
  | { type: 'lines'; field: 'overrides' | 'usage'; lines: EditableLine[] }
  | { type: 'amount'; field: 'delta' | 'set_quantity'; item: string; value: number; unit: string }
  | null;

export function editableOf(kind: ProposalKind, input: unknown, payload: unknown): Editable {
  switch (kind) {
    case 'intake':
      // The plan has one line per input item, in order: lines[i] shows items[i].
      return {
        type: 'items',
        items: (input as IntakeInput).items,
        lines: (payload as IntakePayload).lines.map((l) => ({ item: l.item, quantity: l.quantity_shown, unit: l.unit_shown })),
      };
    case 'consume':
      return {
        type: 'lines',
        field: 'overrides',
        lines: (payload as ConsumePayload).lines.map((l) => ({ item: l.item, quantity: l.quantity, unit: l.unit })),
      };
    case 'revise_consumption':
      return {
        type: 'lines',
        field: 'usage',
        lines: (payload as RevisePayload).lines.map((l) => ({ item: l.item, quantity: l.target, unit: l.unit })),
      };
    case 'adjust': {
      const stored = input as AdjustInput;
      const { item, unit } = payload as AdjustPayload;
      return stored.set_quantity !== undefined
        ? { type: 'amount', field: 'set_quantity', item, value: stored.set_quantity, unit }
        : { type: 'amount', field: 'delta', item, value: stored.delta ?? 0, unit };
    }
    case 'undo':
      return null;
  }
}
