import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalJson, payloadHash, sha256Hex } from '../../src/hash.ts';

/** Rebuilds an object with its keys inserted in reverse order, at every depth. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([k, v]) => [k, reverseKeys(v)]),
    );
  }
  return value;
}

describe('payloadHash', () => {
  it('ignores object key order at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [{ y: 1, x: 2 }] } })).toBe('{"a":{"c":[{"x":2,"y":1}],"d":2},"b":1}');
    expect(payloadHash({ a: 1, b: 2 })).toBe(payloadHash({ b: 2, a: 1 }));
  });

  it('distinguishes different values and array order', () => {
    expect(payloadHash({ a: 1 })).not.toBe(payloadHash({ a: 2 }));
    expect(payloadHash([1, 2])).not.toBe(payloadHash([2, 1]));
  });

  it('property: key order never changes the hash', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(payloadHash(reverseKeys(value))).toBe(payloadHash(value));
      }),
    );
  });

  it('property: canonical JSON round-trips to an equal value', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(JSON.parse(canonicalJson(value))).toStrictEqual(JSON.parse(JSON.stringify(value)));
      }),
    );
  });
});

describe('sha256Hex', () => {
  it('matches a known vector', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
