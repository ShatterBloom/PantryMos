// Agent-local timer tools (IMPLEMENTATION_PLAN §8.6): cooking UX, not pantry data, so not MCP tools.
import { z } from 'zod';
import type { Queryable } from '../db.ts';
import type { ToolSpec } from '../model/types.ts';
import type { ToolOutput } from '../store/toolCalls.ts';
import {
  activeTimers,
  cancelTimer,
  pauseTimer,
  resumeTimer,
  startTimer,
  type Timer,
  timerById,
} from '../store/timers.ts';

const Label = z.string().trim().min(1).max(40).regex(/^[^\p{Cc}]*$/u);
const TimerTarget = z.object({ timer_id: z.uuid().optional(), label: Label.optional() }).strict();

const LOCAL_TOOLS = {
  start_timer: {
    description: 'Start a timer the user asked for, e.g. "set a timer for 5 minutes". Step timers are offered by the app; do not start them unasked.',
    input: z.object({ label: Label, seconds: z.number().int().min(10).max(7200) }).strict(),
  },
  pause_timer: { description: 'Pause a running timer. Pausing a paused timer changes nothing.', input: TimerTarget },
  resume_timer: { description: 'Resume a paused timer for the time it had left.', input: TimerTarget },
  cancel_timer: { description: 'Cancel a running or paused timer.', input: TimerTarget },
  list_timers: { description: 'Time left on each running or paused timer.', input: z.object({}).strict() },
} as const;

export type LocalToolName = keyof typeof LOCAL_TOOLS;
export const LOCAL_TOOL_NAMES = Object.keys(LOCAL_TOOLS) as LocalToolName[];
export const isLocalTool = (name: string): name is LocalToolName => name in LOCAL_TOOLS;

export function localToolSpecs(): ToolSpec[] {
  return LOCAL_TOOL_NAMES.map((name) => {
    const { $schema: _schema, ...inputSchema } = z.toJSONSchema(LOCAL_TOOLS[name].input) as Record<string, unknown>;
    return { name, description: LOCAL_TOOLS[name].description, inputSchema };
  });
}

const fail = (code: string, message: string, details: Record<string, unknown> = {}): ToolOutput => ({
  isError: true,
  data: { code, message, ...details },
  text: [message, details.ask].filter(Boolean).join(' '),
});

const minutes = (s: number) => (s % 60 === 0 ? `${s / 60} minute${s === 60 ? '' : 's'}` : `${s} seconds`);
const describe = (t: Timer) =>
  t.status === 'running'
    ? `${t.label}: ${minutes(t.remaining_seconds!)} left`
    : t.status === 'paused'
      ? `${t.label}: paused with ${minutes(t.remaining_seconds!)} left`
      : `${t.label}: ${t.status}`;
const timerOut = (t: Timer) => ({ timer_id: t.id, label: t.label, status: t.status, seconds: t.seconds, remaining_seconds: t.remaining_seconds });

/** Runs a local tool. `requestId` is the call's uuidv5 (§5.2), so a resumed start_timer starts nothing new. */
export async function runLocalTool(
  q: Queryable,
  conversationId: string,
  name: LocalToolName,
  rawInput: unknown,
  requestId: string,
): Promise<ToolOutput> {
  const parsed = LOCAL_TOOLS[name].input.safeParse(rawInput);
  if (!parsed.success) return fail('invalid_input', `Invalid input for ${name}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);

  if (name === 'start_timer') {
    const { label, seconds } = parsed.data as { label: string; seconds: number };
    const timer = await startTimer(q, { conversationId, requestId, label, seconds });
    return { isError: false, data: timerOut(timer), text: `Timer started: ${label}, ${minutes(seconds)}.` };
  }
  if (name === 'list_timers') {
    const timers = await activeTimers(q, conversationId);
    return {
      isError: false,
      data: { timers: timers.map(timerOut) },
      text: timers.length === 0 ? 'No timers are running.' : timers.map(describe).join('; '),
    };
  }

  const target = await resolveTimer(q, conversationId, parsed.data as z.infer<typeof TimerTarget>);
  if ('isError' in target) return target;
  const apply = { pause_timer: pauseTimer, resume_timer: resumeTimer, cancel_timer: cancelTimer }[name];
  const timer = await apply(q, conversationId, target.id);
  return { isError: false, data: timerOut(timer), text: describe(timer) };
}

/** §8.6: by id; else by label; else the only running or paused timer. */
async function resolveTimer(
  q: Queryable,
  conversationId: string,
  target: z.infer<typeof TimerTarget>,
): Promise<Timer | ToolOutput> {
  if (target.timer_id) return (await timerById(q, conversationId, target.timer_id)) ?? fail('not_found', 'There is no such timer.');
  const active = await activeTimers(q, conversationId);
  const matches = target.label ? active.filter((t) => t.label.toLowerCase() === target.label!.toLowerCase()) : active;
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    return fail('not_found', target.label ? `There is no timer called ${target.label}.` : 'No timer is running.');
  }
  return fail('ambiguous_timer', 'More than one timer is going.', {
    ask: `Which one: ${matches.map((t) => t.label).join(' or ')}?`,
    options: matches.map((t) => ({ timer_id: t.id, label: t.label })),
  });
}
