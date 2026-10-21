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
];

/** A sentence that says what will or would happen, or what has not, claims nothing. */
const HEDGED = /\b(?:not|nothing|n't|yet|until|once|if|when you|after you)\b/i;

/** "Step 3", "step two", "the third step": the app reads steps from the recipe itself. */
const STEP =
  /\bstep\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b|\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+step\b/i;

export interface Grounded {
  text: string;
  /** Sentences left out because they claim a change no commit backs. */
  claims: string[];
  /** Sentences left out because they recite a recipe step. */
  steps: string[];
}

/**
 * The model's reply less what it may not say: claims that the stock changed, unless this turn heard
 * of a commit (`committed`), and any recital of a recipe step.
 */
export function ground(text: string, { committed }: { committed: boolean }): Grounded {
  const out: Grounded = { text: '', claims: [], steps: [] };
  const kept: string[] = [];
  for (const sentence of sentences(text)) {
    // Nova writes curly apostrophes: "I’ve".
    const plain = sentence.replace(/[‘’]/g, "'");
    if (STEP.test(plain)) out.steps.push(sentence);
    else if (!committed && !HEDGED.test(plain) && CLAIMS.some((c) => c.test(plain))) out.claims.push(sentence);
    else kept.push(sentence);
  }
  out.text = kept.join(' ');
  return out;
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
