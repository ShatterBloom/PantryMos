// Zod shapes shared by several tools' input and output schemas (§7.4, §11.5).
import { z } from 'zod';
import type { Step } from '../domain/recipes.ts';

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

/** A recipe step as tools return it; the agent offers a timer when `timer_seconds` is set (§8.6). */
export const StepOut = {
  step_no: z.number(),
  total_steps: z.number(),
  step_text: z.string(),
  timer_seconds: z.number().nullable(),
  timer_label: z.string().nullable(),
};

export function stepOut(step: Step, totalSteps: number) {
  return {
    step_no: step.step_no,
    total_steps: totalSteps,
    step_text: step.text,
    timer_seconds: step.timer_seconds,
    timer_label: step.timer_label,
  };
}
