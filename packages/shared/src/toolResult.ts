import type { BusinessError } from './errors.ts';

/**
 * Reads the business error body back out of an `isError` tool result (IMPLEMENTATION_PLAN §7.1):
 * the second text block holds it as JSON. Null for a success or any other shape.
 */
export function parseErrorResult(result: object): BusinessError | null {
  const { isError, content } = result as { isError?: unknown; content?: unknown };
  if (isError !== true || !Array.isArray(content)) return null;
  const json = (content as Array<{ type?: string; text?: string }>)[1];
  if (json?.type !== 'text' || json.text === undefined) return null;
  try {
    return JSON.parse(json.text) as BusinessError;
  } catch {
    return null;
  }
}
