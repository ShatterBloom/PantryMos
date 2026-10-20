// How cooking tools show a session's planned usage.
import { z } from 'zod';
import type { PlannedLine } from '../domain/cooking.ts';
import type { BaseUnit } from '../domain/items.ts';

export const UsageLineOut = z.object({
  item: z.string(),
  quantity: z.number(),
  unit: z.string(),
  status: z.enum(['planned', 'skipped']),
  origin: z.enum(['recipe', 'substitute']),
  replaces: z.string().nullable(),
});

export function usageLines(
  planned: readonly PlannedLine[],
  items: ReadonlyMap<string, { name: string; base_unit: BaseUnit }>,
): Array<z.infer<typeof UsageLineOut>> {
  const name = (id: string) => items.get(id)?.name ?? id;
  return planned.map((l) => ({
    item: name(l.item_id),
    quantity: l.quantity,
    unit: items.get(l.item_id)?.base_unit ?? '',
    status: l.status,
    origin: l.origin,
    replaces: l.replaces_item_id ? name(l.replaces_item_id) : null,
  }));
}
