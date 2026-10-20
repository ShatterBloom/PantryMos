import { describe, expect, it } from 'vitest';
import { uuidv5 } from '../../src/uuid.ts';

describe('uuidv5', () => {
  it('matches the RFC 9562 test vector and is stable', () => {
    expect(uuidv5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
    const ns = '0b7c1a52-6c63-4d8e-9e51-2e9d1d6c3a10';
    expect(uuidv5(ns, 'gate')).toBe(uuidv5(ns, 'gate'));
    expect(uuidv5(ns, 'gate')).not.toBe(uuidv5(ns, 'timer'));
  });

  it('refuses a namespace that is not a UUID', () => {
    expect(() => uuidv5('nope', 'x')).toThrow(/Not a UUID/);
  });
});
