// The four per-case checks of the conversation eval (IMPLEMENTATION_PLAN §9.4), as pure functions.

export type Verdict = 'pass' | 'fail' | 'unverified';

export interface CheckResult {
  verdict: Verdict;
  /** One line per finding, for the log; empty on a clean pass. */
  notes: string[];
}

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  /** The result's status, or null when the turn ended before a result was sent back. */
  status: 'success' | 'error' | null;
}

const result = (notes: string[], verdict: Verdict = notes.length === 0 ? 'pass' : 'fail'): CheckResult => ({ verdict, notes });

/**
 * Tool selection: `expected` appears in order within the calls (other calls may come between), and
 * no `forbidden` tool was called at all.
 */
export function checkTools(calls: readonly ToolCall[], expected: readonly string[], forbidden: readonly string[] = []): CheckResult {
  const names = calls.map((c) => c.name);
  const notes: string[] = [];
  let at = 0;
  for (const name of expected) {
    const found = names.indexOf(name, at);
    if (found === -1) {
      notes.push(`expected ${expected.join(' → ')} in order; missing ${name} after call #${at} (called: ${names.join(', ') || 'none'})`);
      break;
    }
    at = found + 1;
  }
  for (const name of forbidden) if (names.includes(name)) notes.push(`${name} must not be called`);
  return result(notes);
}

export interface ArgExpectation {
  tool: string;
  /** Key fields: a call of `tool` must contain these, deeply (arrays element by element). */
  args: Record<string, unknown>;
  /** Only successful calls count, e.g. "the server accepts the substitution". Default false. */
  accepted?: boolean;
}

/** Arguments: each expectation is met by at least one call of its tool. */
export function checkArgs(calls: readonly ToolCall[], expectations: readonly ArgExpectation[]): CheckResult {
  const notes: string[] = [];
  for (const e of expectations) {
    const candidates = calls.filter((c) => c.name === e.tool && (!e.accepted || c.status === 'success'));
    if (!candidates.some((c) => contains(c.input, e.args))) {
      const seen = candidates.map((c) => JSON.stringify(c.input)).join('; ') || 'no such call';
      notes.push(`${e.tool} with ${describe(e.args)}${e.accepted ? ' (accepted)' : ''}; got ${seen}`);
    }
  }
  return result(notes);
}

/** Expected arguments as JSON, the matchers shown as /regex/ and <absent>. */
const describe = (args: unknown) =>
  JSON.stringify(args, (_k, v: unknown) => (v === ABSENT ? '<absent>' : v instanceof RegExp ? String(v) : v));

/** An argument the model must leave out (or null), e.g. a date the user never gave. */
export const ABSENT: unique symbol = Symbol('absent');

/**
 * Deep partial match: objects by the expected keys, arrays position by position, a RegExp against a
 * string ("egg" or "eggs"), other values by equality.
 */
export function contains(actual: unknown, expected: unknown): boolean {
  if (expected === ABSENT) return actual === undefined || actual === null;
  if (expected instanceof RegExp) return typeof actual === 'string' && expected.test(actual);
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => contains(actual[i], e));
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false;
    return Object.entries(expected).every(([k, v]) => contains((actual as Record<string, unknown>)[k], v));
  }
  return Object.is(actual, expected);
}

export interface StockRow {
  item: string;
  unit: string;
  quantity: number;
}

/** Net stock change per item between two snapshots; unchanged items are left out. */
export function stockDiff(before: readonly StockRow[], after: readonly StockRow[]): Map<string, { delta: number; unit: string }> {
  const diff = new Map<string, { delta: number; unit: string }>();
  const was = new Map(before.map((r) => [r.item, r.quantity]));
  const items = new Map([...before, ...after].map((r) => [r.item, r.unit]));
  const now = new Map(after.map((r) => [r.item, r.quantity]));
  for (const [item, unit] of items) {
    const delta = round((now.get(item) ?? 0) - (was.get(item) ?? 0));
    if (delta !== 0) diff.set(item, { delta, unit });
  }
  return diff;
}

export interface DbExpectation {
  /** The exact net change per item, in base units; any other item must be unchanged. */
  stock: Record<string, number>;
  /** The kinds of the operations committed during the case, in order. */
  operations: readonly string[];
}

/** DB result: the stock moved exactly as expected, through exactly the expected commits. */
export function checkDb(diff: ReadonlyMap<string, { delta: number }>, operations: readonly string[], expected: DbExpectation): CheckResult {
  const notes: string[] = [];
  for (const item of new Set([...diff.keys(), ...Object.keys(expected.stock)])) {
    const got = diff.get(item)?.delta ?? 0;
    const want = expected.stock[item] ?? 0;
    if (got !== want) notes.push(`${item}: changed by ${got}, expected ${want}`);
  }
  if (operations.join(',') !== expected.operations.join(',')) {
    notes.push(`operations [${operations.join(', ')}], expected [${expected.operations.join(', ')}]`);
  }
  return result(notes);
}

/** A change a reply says happened (not one it proposes), as the extractor read it. */
export interface Claim {
  /** Index of the reply it came from, for the log. */
  message: number;
  item: string;
  /** added / removed: a change by an amount; set_to: a resulting amount ("you now have 10"). */
  change: 'added' | 'removed' | 'set_to';
  /** As said; null when the reply gives no amount ("saved your eggs"). */
  quantity: number | null;
  unit: string | null;
}

/** One committed operation: its net change per item, and the amounts it set (a count, a correction). */
export interface CommittedOp {
  kind: string;
  changes: ReadonlyMap<string, { delta: number; unit: string }>;
  setTo: ReadonlyMap<string, number>;
}

/**
 * The amounts an operation's summary says it set: a stock count's `set_quantity`, and a corrected
 * meal's new usage (`to`). Other kinds only change stock by an amount.
 */
export function setToOf(kind: string, summary: Record<string, unknown>): Map<string, number> {
  const out = new Map<string, number>();
  if (kind === 'adjust' && typeof summary.set_quantity === 'number') out.set(String(summary.item), summary.set_quantity);
  if (kind === 'revise_consumption' && Array.isArray(summary.lines)) {
    for (const l of summary.lines as Array<{ item: string; to: number }>) out.set(l.item, l.to);
  }
  return out;
}

const UNIT_SCALE: ReadonlyArray<[RegExp, string, number]> = [
  [/^(g|grams?)$/, 'g', 1],
  [/^(kg|kilograms?|kilos?)$/, 'g', 1000],
  [/^(ml|milliliters?|millilitres?)$/, 'ml', 1],
  [/^(l|liters?|litres?)$/, 'ml', 1000],
  [/^(count|pcs?|pieces?|whole|units?)$/, 'count', 1],
];

/** A said amount in an item's base unit, or null when the unit is not one we can convert. */
export function toBase(quantity: number, unit: string | null, item: string, baseUnit: string): number | null {
  const u = (unit ?? '').trim().toLowerCase();
  // "3 eggs", "2 tomatoes", "2 cloves" (of garlic clove): the unit is the item, its last word, or absent.
  if (baseUnit === 'count' && (u === '' || sameItem(u, item) || sameItem(u, item.split(' ').at(-1)!))) return quantity;
  for (const [pattern, base, scale] of UNIT_SCALE) if (pattern.test(u)) return base === baseUnit ? round(quantity * scale) : null;
  return null;
}

/** Item names as people say them: case, and a plural "s"/"es", do not matter. */
export function sameItem(a: string, b: string): boolean {
  // Each name's possible singulars: as is, less "s" ("cloves"), less "es" ("tomatoes").
  const forms = (s: string) => {
    const x = s.trim().toLowerCase();
    return [x, x.replace(/s$/, ''), x.replace(/es$/, '')];
  };
  const ofB = forms(b);
  return forms(a).some((f) => ofB.includes(f));
}

/**
 * Reply consistency: every claimed change matches what was committed, in direction and (when an
 * amount is said) in amount: one operation's change, or the case's net change, for that item; a
 * set_to claim, an amount an operation set. A claim in a unit we cannot convert is unverified, not
 * passed.
 */
export function checkClaims(
  claims: readonly Claim[],
  ops: readonly CommittedOp[],
  net: ReadonlyMap<string, { delta: number; unit: string }>,
): CheckResult {
  const fails: string[] = [];
  const unverified: string[] = [];
  const changes = [...ops.map((o) => o.changes), net].flatMap((m) => [...m]);
  for (const c of claims) {
    const said = `reply ${c.message}: ${c.change.replace('_', ' ')} ${c.quantity ?? ''} ${c.unit ?? ''} ${c.item}`.replace(/\s+/g, ' ');
    const ofItem = changes.filter(([item]) => sameItem(item, c.item));
    if (ofItem.length === 0) {
      fails.push(`${said}, but no ${c.item} change was committed`);
      continue;
    }
    const [item, { unit }] = ofItem[0]!;
    const base = c.quantity === null ? null : toBase(c.quantity, c.unit, item, unit);
    if (c.quantity !== null && base === null) {
      unverified.push(`${said}: cannot convert to ${unit}`);
      continue;
    }
    const committed = (what: string) => `${said}, but ${what} was committed`;
    if (c.change === 'set_to') {
      const set = ops.flatMap((o) => [...o.setTo]).filter(([i]) => sameItem(i, c.item)).map(([, q]) => q);
      if (base !== null && !set.includes(base)) fails.push(committed(set.length > 0 ? `${item} set to ${set.join(' or ')} ${unit}` : `no amount set for ${item}`));
      continue;
    }
    const sameWay = ofItem.filter(([, d]) => (d.delta > 0) === (c.change === 'added'));
    const amounts = [...new Set(ofItem.map(([, d]) => `${d.delta > 0 ? '+' : ''}${d.delta}`))].join(' or ');
    if (sameWay.length === 0) fails.push(committed(`${item} ${amounts} ${unit}`));
    else if (base !== null && !sameWay.some(([, d]) => Math.abs(d.delta) === base)) fails.push(committed(`${item} ${amounts} ${unit}`));
  }
  if (fails.length > 0) return result([...fails, ...unverified], 'fail');
  return result(unverified, unverified.length > 0 ? 'unverified' : 'pass');
}

const round = (n: number) => Math.round(n * 1000) / 1000;

const EXPIRY = /\bexpir(?:e|es|ed|ing|y|ation)\b/i;

/**
 * Date honesty (story B3, PRD FR-7): an item whose batches have no package date has only an
 * estimated priority date, which Mos must never call an expiry. `estimated` are those items' names;
 * a sentence that names one and talks of expiring fails. A deterministic part of the reply check.
 */
export function checkDateWords(replies: readonly string[], estimated: readonly string[]): CheckResult {
  const notes: string[] = [];
  replies.forEach((reply, i) => {
    for (const sentence of reply.split(/(?<=[.!?])\s+/)) {
      // Clause by clause, so "the milk expires Oct 24, and the spinach is fine" blames only the milk.
      // A pronoun ("it expires") is not followed back: the check misses some, it does not invent.
      const named = new Set<string>();
      for (const clause of sentence.split(/[,;:]|\band\b|\bbut\b/i)) {
        if (!EXPIRY.test(clause)) continue;
        // One- and two-word names: "spinach", "garlic cloves".
        const words = clause.toLowerCase().split(/[^a-z]+/);
        for (const item of estimated) if (words.some((w, j) => sameItem(w, item) || sameItem(`${w} ${words[j + 1] ?? ''}`, item))) named.add(item);
      }
      for (const item of named) notes.push(`reply ${i}: calls the estimated date of ${item} an expiry: "${sentence}"`);
    }
  });
  return result(notes);
}

/** Two results as one: the worse verdict, all the notes. */
export function bothChecks(a: CheckResult, b: CheckResult): CheckResult {
  const rank: Record<Verdict, number> = { pass: 0, unverified: 1, fail: 2 };
  return { verdict: rank[a.verdict] >= rank[b.verdict] ? a.verdict : b.verdict, notes: [...a.notes, ...b.notes] };
}
