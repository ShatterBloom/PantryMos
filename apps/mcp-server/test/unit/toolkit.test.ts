import { META_CONVERSATION_ID, META_REQUEST_ID } from '@pantrymos/shared';
import { describe, expect, it } from 'vitest';
import { PantryError } from '../../src/domain/errors.ts';
import {
  errorResult,
  INSPECTOR_CONVERSATION_ID,
  parseErrorResult,
  readRequestMeta,
  runReadTool,
  successResult,
} from '../../src/mcp/toolkit.ts';

const RID = '6f1c2b0e-8a8e-4c55-9d0e-1f6a3a1e2b3c';
const CID = '0b8a7f43-5d1f-4c3e-8c2b-7a9e4d6f1a20';
const strict = { needsConversation: true, allowAnonWrites: false };
const anon = { needsConversation: true, allowAnonWrites: true };

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as PantryError).code;
  }
  return null;
};

describe('readRequestMeta', () => {
  it('reads both ids from _meta', () => {
    expect(readRequestMeta({ [META_REQUEST_ID]: RID, [META_CONVERSATION_ID]: CID }, strict)).toEqual({
      requestId: RID,
      conversationId: CID,
    });
  });

  it('requires a UUID request_id', () => {
    expect(codeOf(() => readRequestMeta(undefined, strict))).toBe('request_id_required');
    expect(codeOf(() => readRequestMeta({ [META_REQUEST_ID]: 'abc', [META_CONVERSATION_ID]: CID }, strict))).toBe(
      'request_id_required',
    );
    expect(codeOf(() => readRequestMeta({ [META_REQUEST_ID]: 42, [META_CONVERSATION_ID]: CID }, strict))).toBe(
      'request_id_required',
    );
  });

  it('requires a conversation id only for tools that route outcomes to a conversation', () => {
    expect(codeOf(() => readRequestMeta({ [META_REQUEST_ID]: RID }, strict))).toBe('conversation_id_required');
    expect(readRequestMeta({ [META_REQUEST_ID]: RID }, { ...strict, needsConversation: false })).toEqual({
      requestId: RID,
      conversationId: null,
    });
  });

  it('dev mode fills in ids that are absent, but never accepts malformed ones', () => {
    const meta = readRequestMeta(undefined, anon);
    expect(meta.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(meta.conversationId).toBe(INSPECTOR_CONVERSATION_ID);
    expect(readRequestMeta(undefined, anon).requestId).not.toBe(meta.requestId);
    expect(codeOf(() => readRequestMeta({ [META_REQUEST_ID]: 'abc' }, anon))).toBe('request_id_required');
    expect(codeOf(() => readRequestMeta({ [META_REQUEST_ID]: RID, [META_CONVERSATION_ID]: 'x' }, anon))).toBe(
      'conversation_id_required',
    );
  });
});

describe('tool results (§7.1)', () => {
  it('success carries structured data plus one sentence of text', () => {
    expect(successResult({ a: 1 }, 'Done.')).toEqual({
      content: [{ type: 'text', text: 'Done.' }],
      structuredContent: { a: 1 },
    });
  });

  it('a business error sets isError, appends the question, and carries the body as JSON', () => {
    const body = new PantryError('needs_clarification', 'Unit unknown.', { ask: 'How many eggs in a carton?' }).toBody();
    const result = errorResult(body);
    expect(result).toEqual({
      isError: true,
      content: [
        { type: 'text', text: 'Unit unknown. How many eggs in a carton?' },
        { type: 'text', text: JSON.stringify(body) },
      ],
    });
    expect(parseErrorResult(result)).toEqual(body);
    expect(errorResult(new PantryError('unknown_item', 'No such item.').toBody()).content?.[0]).toEqual({
      type: 'text',
      text: 'No such item.',
    });
  });

  it('never sets structuredContent on errors (SDK clients validate it against the success schema)', () => {
    expect(errorResult(new PantryError('unknown_item', 'x').toBody())).not.toHaveProperty('structuredContent');
  });

  it('parseErrorResult ignores successes and malformed results', () => {
    expect(parseErrorResult(successResult({ a: 1 }, 'ok'))).toBeNull();
    expect(parseErrorResult({ isError: true, content: [{ type: 'text', text: 'only text' }] })).toBeNull();
    expect(parseErrorResult({ isError: true, content: [{ type: 'text', text: 'x' }, { type: 'text', text: '{bad' }] })).toBeNull();
    expect(parseErrorResult({ isError: true })).toBeNull();
  });

  it('runReadTool turns PantryError into a result and rethrows faults', async () => {
    await expect(runReadTool(async () => ({ data: { x: 1 }, text: 'ok' }))).resolves.toMatchObject({
      structuredContent: { x: 1 },
    });
    await expect(
      runReadTool(async () => {
        throw new PantryError('ambiguous_item', 'Which one?', { options: ['a', 'b'] });
      }),
    ).resolves.toSatisfy((r) => parseErrorResult(r as never)?.code === 'ambiguous_item');
    await expect(
      runReadTool(async () => {
        throw new Error('db down');
      }),
    ).rejects.toThrow('db down');
  });
});

describe('PantryError', () => {
  it('defaults to HTTP 409 and spreads details into the body', () => {
    const err = new PantryError('step_conflict', 'Step moved.', { current_step: 3 });
    expect(err.status).toBe(409);
    expect(err.toBody()).toEqual({ code: 'step_conflict', message: 'Step moved.', current_step: 3 });
    expect(new PantryError('unknown_item', 'x', {}, 404).status).toBe(404);
  });
});
