// Zod shapes shared by several tools' input and output schemas (§7.4, §11.5).
import { z } from 'zod';

/** User-supplied names: ≤ 60 chars, no control characters (§11.5). */
export const NameInput = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[^\p{Cc}]*$/u, 'must not contain control characters');

export const BatchOut = z.object({
  batch_id: z.string(),
  item: z.string(),
  quantity: z.number(),
  unit: z.enum(['count', 'g', 'ml']),
  priority_date: z.string(),
  priority_source: z.enum(['package', 'estimate']),
  date_label: z.string(),
});
