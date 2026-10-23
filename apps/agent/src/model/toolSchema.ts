// Tool input schemas as OpenAI's APIs accept them.

/**
 * OpenAI refuses a whole request whose tool schemas hold a `pattern` with a Unicode property escape
 * (the MCP tools' `^[^\p{Cc}]*$`: "is not a 'regex'"). Such patterns are left out of what the model
 * sees; the MCP server still checks every input against its own schema.
 */
export function withoutUnicodePatterns(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withoutUnicodePatterns);
  if (typeof schema !== 'object' || schema === null) return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key, value]) => !(key === 'pattern' && typeof value === 'string' && /\\[pP]\{/.test(value)))
      .map(([key, value]) => [key, withoutUnicodePatterns(value)]),
  );
}
