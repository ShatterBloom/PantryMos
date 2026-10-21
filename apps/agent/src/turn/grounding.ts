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
  /\bstep\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b|\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+step\b|\bnext\s+step\s+is\b/i;

/** "There's a timer set for 60 seconds", "the timer is running", "I've started a timer". */
const TIMER_CLAIMS: readonly RegExp[] = [
  /\btimer\s+(?:is\s+|has\s+been\s+|was\s+)?(?:now\s+)?(?:set|running|started|going)\b/i,
  /\b(?:I've|I have|I)\s+(?:just\s+)?(?:set|started)\b.*\btimer\b/i,
];

export interface Grounded {
  text: string;
  /** Sentences left out because they claim a change (of stock or timers) nothing in the turn backs. */
  claims: string[];
  /** Sentences left out because they recite a recipe step. */
  steps: string[];
}

/**
 * The model's reply less what it may not say: claims that the stock changed, unless this turn heard
 * of a commit (`committed`); claims that a timer runs, unless the turn started one (`timerStarted`);
 * and any recital of a recipe step.
 */
export function ground(text: string, { committed, timerStarted = false }: { committed: boolean; timerStarted?: boolean }): Grounded {
  const out: Grounded = { text: '', claims: [], steps: [] };
  const kept: string[] = [];
  for (const sentence of sentences(text)) {
    // Nova writes curly apostrophes: "I’ve".
    const plain = sentence.replace(/[‘’]/g, "'");
    const asserts = !HEDGED.test(plain) && !plain.endsWith('?');
    if (STEP.test(plain)) out.steps.push(sentence);
    else if (asserts && !committed && !SHOPPING_LIST.test(plain) && CLAIMS.some((c) => c.test(plain))) out.claims.push(sentence);
    else if (asserts && !timerStarted && TIMER_CLAIMS.some((c) => c.test(plain))) out.claims.push(sentence);
    else kept.push(sentence);
  }
  out.text = kept.join(' ');
  return out;
}

/** "Say **confirm** to apply this", "I need you to say "confirm"…": the read-back asks that itself. */
const ASKS_CONFIRM = /\b(?:say|tap|click|press|hit)\b[^.!?]*\bconfirm\b/i;

const NUMBER = /\d+(?:\.\d+)?/g;

/**
 * The model's speech less what the card's read-back, appended after it, says again or asks itself
 * (§8.5): the read-back, asks to confirm, sentences that only restate the card's amounts ("It will
 * deduct 3 eggs and 2 tomatoes", eval G4, P1), and any question, as the read-back ends with the one
 * the user answers. A sentence with an amount the card lacks, such as a shortfall, stays.
 */
export function withoutRecital(text: string, readback: string): string {
  const onCard = new Set(readback.match(NUMBER) ?? []);
  return sentences(text.split(readback).join(' '))
    .filter((s) => {
      if (ASKS_CONFIRM.test(s) || s.endsWith('?')) return false;
      const numbers = s.match(NUMBER) ?? [];
      return numbers.length === 0 || !numbers.every((n) => onCard.has(n));
    })
    .join(' ');
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
