// Undo (IMPLEMENTATION_PLAN §6.6): reverse committed events with new, opposite events (I3).
import type { ProposalKind } from '../db/proposals.ts';
import { PantryError } from './errors.ts';
import { listAnd, speakQuantity } from './speech.ts';
import type { BaseUnit } from './items.ts';
import { roundQuantity } from './units.ts';

export type UndoScope = 'operation' | 'session';

export interface UndoableOperation {
  id: string;
  kind: ProposalKind;
  session_id: string | null;
  recipe: string | null;
}

/** An event to reverse; the reversal carries the original's session so I5 nets it out. */
export interface Reversal {
  reverts_event_id: string;
  operation_id: string;
  batch_id: string;
  item_id: string;
  delta: number;
  session_id: string | null;
}

/**
 * The scope an undo of `op` gets when the caller gave none (§6.6): a meal's consume undoes the meal;
 * anything else, the operation itself. For `target: "last"` a revision could mean the correction or
 * the whole meal, so it asks; a revision named by id means that correction.
 */
export function defaultScope(op: UndoableOperation, last: boolean): UndoScope {
  if (op.kind === 'revise_consumption' && last) throw whichUndo(op.id, op.session_id!, op.recipe);
  return op.kind === 'consume' ? 'session' : 'operation';
}

/**
 * "Undo that" on a corrected meal could mean the correction or the whole meal (PRD FR-21): the user
 * says which, never the caller on their behalf.
 */
export function whichUndo(correctionId: string, sessionId: string, recipe: string | null): PantryError {
  const meal = recipe ?? 'meal';
  return new PantryError('ambiguous_undo', `The meal was corrected: undo just the correction, or the whole ${meal}?`, {
    ask: `Undo just the correction, or the whole ${meal}?`,
    options: [
      { scope: 'operation', target: correctionId, label: 'undo the correction' },
      { scope: 'session', target: sessionId, label: `undo the whole ${meal}` },
    ],
  });
}

/** Each live event reversed by an equal and opposite one. */
export function reversalsOf(
  events: ReadonlyArray<{ event_id: string; operation_id: string; batch_id: string; item_id: string; delta: number; session_id: string | null }>,
): Reversal[] {
  return events.map((e) => ({
    reverts_event_id: e.event_id,
    operation_id: e.operation_id,
    batch_id: e.batch_id,
    item_id: e.item_id,
    delta: -e.delta,
    session_id: e.session_id,
  }));
}

/**
 * Refuses an undo that would take a batch below zero (§6.6): stock from an intake or a found-stock
 * adjustment that has since been used. The user adjusts the stock instead.
 */
export function checkNotNegative(
  reversals: readonly Reversal[],
  stock: ReadonlyMap<string, { quantity: number; item: string; unit: BaseUnit }>,
): void {
  const after = new Map<string, number>();
  for (const r of reversals) after.set(r.batch_id, roundQuantity((after.get(r.batch_id) ?? stock.get(r.batch_id)!.quantity) + r.delta));
  const short = [...after].filter(([, quantity]) => quantity < 0).map(([batchId]) => stock.get(batchId)!);
  if (short.length === 0) return;
  const items = [...new Set(short.map((b) => b.item))];
  throw new PantryError('would_go_negative', `Some of that ${listAnd(items)} has already been used, so it can't be undone.`, {
    items,
    ask: 'Adjust the stock to what is there now instead?',
    options: ['adjust the stock instead'],
  });
}

export interface ItemChange {
  item: string;
  /** Net change to the item's stock, in its base unit: positive is put back. */
  delta: number;
  unit: BaseUnit;
}

/** The undo's net stock change per item, by name; items whose events cancel out are left out. */
export function netChanges(
  reversals: readonly Reversal[],
  items: ReadonlyMap<string, { name: string; base_unit: BaseUnit }>,
): ItemChange[] {
  const net = new Map<string, number>();
  for (const r of reversals) net.set(r.item_id, roundQuantity((net.get(r.item_id) ?? 0) + r.delta));
  return [...net]
    .filter(([, delta]) => delta !== 0)
    .map(([itemId, delta]) => ({ item: items.get(itemId)!.name, delta, unit: items.get(itemId)!.base_unit }))
    .sort((a, b) => a.item.localeCompare(b.item));
}

/** What the undo puts back and takes off, per item: "putting back 2 eggs and taking off 1 tomato". */
export function describeReversal(changes: readonly ItemChange[]): string {
  const amount = (c: ItemChange) => speakQuantity(c.item, Math.abs(c.delta), c.unit, c.unit);
  const back = changes.filter((c) => c.delta > 0).map(amount);
  const off = changes.filter((c) => c.delta < 0).map(amount);
  const parts = [back.length > 0 ? `putting back ${listAnd(back)}` : '', off.length > 0 ? `taking off ${listAnd(off)}` : ''];
  return parts.filter(Boolean).join(' and ') || 'changing no stock';
}
