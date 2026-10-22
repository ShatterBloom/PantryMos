// Guardrails on what Mos says (IMPLEMENTATION_PLAN §8.3): the prompt asks, these enforce. A sentence
// that states what did not happen is neither said nor kept in the model's history, where the model
// would copy it in later turns.

/** Verbs that say the stock changed. */
const DONE = 'recorded|deducted|saved|added|removed|subtracted|logged|updated|undone|reverted|thrown out|taken off|put back|restocked|discarded|used up';

/** "I've recorded…", "…have been deducted", "…are now in your stock"; "I've added a card" is not stock. */
const CLAIMS: readonly RegExp[] = [
  new RegExp(`\\b(?:I|I've|I have|we've|we have)\\s+(?:just\\s+|already\\s+|now\\s+)?(?:${DONE})\\b(?!\\s+(?:a|the|this|that|your)\\s+card)`, 'i'),
  new RegExp(`\\b(?:has|have)\\s+(?:now\\s+|already\\s+)?been\\s+(?:${DONE})\\b`, 'i'),
  /\b(?:is|are)\s+now\s+in\s+(?:your\s+)?(?:stock|inventory|pantry)\b/i,
  // "Saved: 20 grams of butter, …": the app's own commit wording, copied before any commit (eval P7).
  /^(?:saved|recorded|deducted|logged)\b/i,
];

/** The shopping list changes when its tool runs, with no card: saying so is true. */
const SHOPPING_LIST = /\bshopping\s+list\b/i;

/** A sentence that says what will or would happen, or what has not, claims nothing. */
const HEDGED = /\b(?:not|nothing|n't|yet|until|once|if|when you|after you)\b/i;

/** "Step 3", "step two", "the third step", "the next step is…": the app reads steps from the recipe itself. */
const STEP =
  /\bstep\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b|\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+step\b|\bnext\s+step\s*(?:is\b|:)/i;

/** "There's a timer set for 60 seconds", "the timer is running", "I've started a timer", "the app set a timer". */
const TIMER_CLAIMS: readonly RegExp[] = [
  /\btimer\s+(?:is\s+|has\s+been\s+|was\s+)?(?:now\s+)?(?:set|running|started|going)\b/i,
  /\b(?:I've|I have|I|the app(?:\s+has)?)\s+(?:just\s+)?(?:set|started)\b.*\btimer\b/i,
];

const BULLET = /^(?:[-*•]|\d+[.)])\s+/;

export interface Grounded {
  text: string;
  /** Sentences left out because they claim a stock change nothing in the turn backs. */
  claims: string[];
  /** Sentences left out because they claim a timer runs that the turn did not start. */
  timers: string[];
  /** Sentences left out because they recite a recipe step. */
  steps: string[];
}

/**
 * The model's reply less what it may not say: claims that the stock changed, unless this turn heard
 * of a commit (`committed`); claims that a timer runs, unless the turn started one (`timerStarted`);
 * and any recital of a recipe step.
 */
export function ground(text: string, { committed, timerStarted = false }: { committed: boolean; timerStarted?: boolean }): Grounded {
  const out: Grounded = { text: '', claims: [], timers: [], steps: [] };
  const kept: string[] = [];
  for (const sentence of sentences(spoken(text))) {
    // Nova writes curly apostrophes: "I’ve".
    const plain = sentence.replace(/[‘’]/g, "'");
    const asserts = !HEDGED.test(plain) && !plain.endsWith('?');
    if (STEP.test(plain)) out.steps.push(sentence);
    else if (asserts && !committed && !SHOPPING_LIST.test(plain) && CLAIMS.some((c) => c.test(plain))) out.claims.push(sentence);
    else if (asserts && !timerStarted && TIMER_CLAIMS.some((c) => c.test(plain))) out.timers.push(sentence);
    else kept.push(sentence);
  }
  out.text = kept.join(' ');
  return out;
}

/**
 * "Say **confirm** to apply this", "You'll see a card asking you to confirm": the read-back asks
 * that itself. "After you confirm, I'll tell you what to do next" promises what nobody says: a
 * confirm gets the app's templated reply (eval G4).
 */
const CONFIRM = /\bconfirm/i;

const NUMBER = /\d+(?:\.\d+)?/g;

/**
 * The model's speech less what the card's read-back, appended after it, says again or asks itself
 * (§8.5): the read-back, any talk of confirming, sentences that only restate the card's amounts
 * ("It will deduct 3 eggs and 2 tomatoes", eval G4, P1), and any question, as the read-back ends
 * with the one the user answers. A sentence with an amount the card lacks, such as a shortfall, stays.
 */
export function withoutRecital(text: string, readback: string): string {
  const onCard = new Set(readback.match(NUMBER) ?? []);
  return sentences(withoutQuestions(text.split(readback).join(' ')))
    .filter((s) => {
      if (CONFIRM.test(s)) return false;
      const numbers = s.match(NUMBER) ?? [];
      return numbers.length === 0 || !numbers.every((n) => onCard.has(n));
    })
    .join(' ');
}

/** Words that say nothing about what a step is about. */
const FILLER = new Set(['the', 'and', 'for', 'you', 'your', 'with', 'are', 'this', 'that', 'will', 'now', 'here', 'current', 'step', 'next', 'when', 'ready', 'say', 'then', 'into', 'until', 'about', 'again', 'there']);

const words = (text: string) => (text.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => w.length >= 3 && !FILLER.has(w));

/** "boiling" and "boil", "eggs" and "egg": the same word to within its ending. */
function sameStem(a: string, b: string): boolean {
  const n = Math.min(4, a.length, b.length);
  return a.slice(0, n) === b.slice(0, n);
}

/** "Say "next" when you're ready", "Let me know by saying next": the user's cue, which follows the step. */
const NEXT = /\bnext\b/i;
const SAY = /\bsay(?:ing)?\b/i;

/**
 * The model's speech less what the step the app reads after it says again, and any question, as the
 * user's answer to a step is "next": "Here's your current step: pour in the milk…", "The pasta is
 * boiling and will be done in about 8 minutes", "What's your next move?" (eval P9, G5). A sentence
 * leaves when most of its words are the step's. Talk of the next step leaves too: a cue to say
 * "next" is `cue`, said after the step, and a promise such as "I'll let you know when it's time for
 * the next step" is one nobody keeps.
 */
export function withoutStepRecital(text: string, stepText: string): { text: string; cue: string | null } {
  const step = words(stepText);
  let cue: string | null = null;
  const kept = sentences(withoutQuestions(text)).filter((s) => {
    if (NEXT.test(s)) {
      if (cue === null && SAY.test(s)) cue = s;
      return false;
    }
    const own = words(s);
    const shared = own.filter((w) => step.some((t) => sameStem(w, t))).length;
    return own.length < 2 || shared / own.length < 0.6;
  });
  return { text: kept.join(' '), cue };
}

/** The model's speech less its questions, when the app asks the one the user answers. */
export function withoutQuestions(text: string): string {
  return sentences(text)
    .filter((s) => !s.endsWith('?'))
    .join(' ');
}

/**
 * Markdown read aloud as speech: emphasis and headings dropped, a list said as one run of items
 * ("…fix this: make fewer servings, use a substitute", eval G4).
 */
function spoken(text: string): string {
  const out: string[] = [];
  let items: string[] = [];
  const flush = () => {
    if (items.length > 0) out.push(`${items.join(', ')}.`);
    items = [];
  };
  for (const raw of text.replace(/\*\*|__|`/g, '').split('\n')) {
    const line = raw.trim().replace(/^#+\s*/, '');
    if (BULLET.test(line)) {
      items.push(line.replace(BULLET, '').replace(/[.,;]$/, '').replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase()));
    } else if (line !== '') {
      flush();
      out.push(line);
    }
  }
  flush();
  return out.join(' ');
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
