// How a committed operation is described to the user (§7.4 list_recent_operations, PRD FR-21).
import type { ProposalKind } from '../db/proposals.ts';
import type { BaseUnit } from './items.ts';
import { listAnd, speakQuantity } from './speech.ts';

export interface OperationChange {
  item: string;
  unit: BaseUnit;
  /** Net change in base units: negative left the pantry, positive came back or in. */
  delta: number;
}

const LABELS: Record<ProposalKind, (recipe: string | null) => string> = {
  intake: () => 'Groceries added',
  consume: (recipe) => (recipe ? `Cooked ${recipe}` : 'Cooked'),
  revise_consumption: (recipe) => (recipe ? `Corrected ${recipe}` : 'Corrected a meal'),
  adjust: () => 'Stock adjusted',
  undo: () => 'Undo',
};

/** "Cooked creamy spinach pasta: −2 eggs, −250 milliliters of milk", from the ledger's net changes. */
export function describeOperation(kind: ProposalKind, recipe: string | null, changes: readonly OperationChange[]): string {
  const label = LABELS[kind](recipe);
  if (changes.length === 0) return `${label}: no stock changed`;
  const parts = changes.map((c) => `${c.delta < 0 ? '−' : '+'}${speakQuantity(c.item, Math.abs(c.delta), c.unit, c.unit)}`);
  return `${label}: ${listAnd(parts)}`;
}
