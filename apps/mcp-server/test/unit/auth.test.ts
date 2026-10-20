import { describe, expect, it } from 'vitest';
import { bearerToken, originAllowed, serviceTokenMatches } from '../../src/security/auth.ts';

describe('bearerToken', () => {
  it('extracts the token, case-insensitive scheme', () => {
    expect(bearerToken('Bearer abc123')).toBe('abc123');
    expect(bearerToken('bearer abc123')).toBe('abc123');
  });

  it.each([undefined, '', 'Bearer', 'Bearer ', 'Basic abc123', 'Bearer a b', 'Tokenabc'])('rejects %j', (header) => {
    expect(bearerToken(header)).toBeNull();
  });
});

describe('originAllowed', () => {
  const allowed = ['http://localhost:6274'];

  it('lets non-browser clients without Origin through to bearer auth', () => {
    expect(originAllowed(undefined, allowed)).toBe(true);
  });

  it('requires an exact allow-list match when Origin is present', () => {
    expect(originAllowed('http://localhost:6274', allowed)).toBe(true);
    expect(originAllowed('http://localhost:6275', allowed)).toBe(false);
    expect(originAllowed('http://localhost:6274.evil.example', allowed)).toBe(false);
    expect(originAllowed('null', allowed)).toBe(false);
  });

  it('rejects every Origin when the allow-list is empty', () => {
    expect(originAllowed('http://localhost:6274', [])).toBe(false);
  });
});

describe('serviceTokenMatches', () => {
  const expected = 'service-token-0123456789';

  it('accepts the exact token', () => {
    expect(serviceTokenMatches(expected, expected)).toBe(true);
  });

  it('rejects missing, different, prefix and longer tokens', () => {
    expect(serviceTokenMatches(expected, undefined)).toBe(false);
    expect(serviceTokenMatches(expected, '')).toBe(false);
    expect(serviceTokenMatches(expected, 'service-token-012345678')).toBe(false);
    expect(serviceTokenMatches(expected, `${expected}x`)).toBe(false);
  });
});
