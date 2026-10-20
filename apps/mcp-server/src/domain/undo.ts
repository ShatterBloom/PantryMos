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
  if (op.kind === 'revise_consumption' && last) {
    const meal = op.recipe ?? 'meal';
    throw new PantryError('ambiguous_undo', `The last change was a correction to ${meal}.`, {
      ask: `Undo just the correction, or the whole ${meal}?`,
      options: [
        { scope: 'operation', target: op.id, label: 'undo the correction' },
        { scope: 'session', target: op.session_id, label: `undo the whole ${meal}` },
      ],
    });
  }
  return op.kind === 'consume' ? 'session' : 'operation';
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

/** What the undo puts back and takes off, per item: "putting back 2 eggs and taking off 1 tomato". */
export function describeReversal(
  reversals: readonly Reversal[],
  items: ReadonlyMap<string, { name: string; base_unit: BaseUnit }>,
): string {
  const net = new Map<string, number>();
  for (const r of reversals) net.set(r.item_id, roundQuantity((net.get(r.item_id) ?? 0) + r.delta));
  const amount = (itemId: string, n: number) => {
    const item = items.get(itemId)!;
    return speakQuantity(item.name, Math.abs(n), item.base_unit, item.base_unit);
  };
  const byName = [...net].sort(([a], [b]) => items.get(a)!.name.localeCompare(items.get(b)!.name));
  const back = byName.filter(([, d]) => d > 0).map(([id, d]) => amount(id, d));
  const off = byName.filter(([, d]) => d < 0).map(([id, d]) => amount(id, d));
  const parts = [back.length > 0 ? `putting back ${listAnd(back)}` : '', off.length > 0 ? `taking off ${listAnd(off)}` : ''];
  return parts.filter(Boolean).join(' and ') || 'changing no stock';
}
