import { describe, expect, it } from 'vitest';
import { canonicalJson, payloadHash } from '../src/hash.ts';

describe('payloadHash', () => {
  it('ignores object key order at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [{ y: 1, x: 2 }] } })).toBe('{"a":{"c":[{"x":2,"y":1}],"d":2},"b":1}');
    expect(payloadHash({ a: 1, b: 2 })).toBe(payloadHash({ b: 2, a: 1 }));
  });

  it('distinguishes different values and array order', () => {
    expect(payloadHash({ a: 1 })).not.toBe(payloadHash({ a: 2 }));
    expect(payloadHash([1, 2])).not.toBe(payloadHash([2, 1]));
  });
});
