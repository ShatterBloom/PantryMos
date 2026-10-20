// Text normalization for user-spoken names and units. English only (PRD §4).

/** Lowercase, trimmed, inner whitespace collapsed. */
export function normalizeName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Conservative English singular of the last word: "tomatoes" → "tomato", "berries" → "berry". */
export function singular(word: string): string {
  if (/[^aeiou]ies$/.test(word) && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/(?:ch|sh|ss|x|z|[^aeiou]o)es$/.test(word)) return word.slice(0, -2);
  if (/[^s]s$/.test(word) && !/(?:us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

/** English plural of the last word, for spoken read-backs: "egg" → "eggs", "tomato" → "tomatoes". */
export function plural(word: string): string {
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(?:s|x|z|ch|sh|[^aeiou]o)$/.test(word)) return `${word}es`;
  return `${word}s`;
}

/** Edit distance, used only to suggest catalog items for an unknown name. */
export function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr.push(Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost));
    }
    prev = curr;
  }
  return prev[b.length]!;
}
