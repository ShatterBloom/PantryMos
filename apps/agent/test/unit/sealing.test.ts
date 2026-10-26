import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { TokenSealer } from '../../src/chatgpt/sealing.ts';

describe('TokenSealer', () => {
  const sealer = new TokenSealer('chatgpt-token-key-for-tests-0123456789');

  it('opens what it sealed, for any token', () => {
    fc.assert(fc.property(fc.string(), (token) => sealer.open('access_token', sealer.seal('access_token', token)) === token));
  });

  it('seals the same token differently each time, never in plain text', () => {
    const a = sealer.seal('refresh_token', 'refresh-1');
    const b = sealer.seal('refresh_token', 'refresh-1');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^v1\.[\w-]+\.[\w-]+$/);
    expect(a).not.toContain('refresh-1');
  });

  it('opens nothing under another key, in another column, tampered with, or in plain text', () => {
    const sealed = sealer.seal('refresh_token', 'refresh-1');
    expect(new TokenSealer('another-chatgpt-token-key-0123456789').open('refresh_token', sealed)).toBeNull();
    expect(sealer.open('access_token', sealed)).toBeNull();
    const [version, iv, body] = sealed.split('.') as [string, string, string];
    const flipped = Buffer.from(body, 'base64url');
    flipped[0] = flipped[0]! ^ 1;
    expect(sealer.open('refresh_token', `${version}.${iv}.${flipped.toString('base64url')}`)).toBeNull();
    expect(sealer.open('refresh_token', `${version}.${iv}`)).toBeNull();
    expect(sealer.open('refresh_token', `${sealed}.extra`)).toBeNull();
    expect(sealer.open('refresh_token', `v2.${iv}.${body}`)).toBeNull();
    expect(sealer.open('refresh_token', 'refresh-1')).toBeNull();
  });
});
