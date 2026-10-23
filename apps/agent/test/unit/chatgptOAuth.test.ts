import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { authorizeUrl, listModels, OAuthError, pkce, refreshTokens, revoke, verifyIdToken } from '../../src/chatgpt/oauth.ts';

const ENDPOINTS = { authUrl: 'https://auth.example.test/', apiUrl: 'https://api.example.test/v1' };
const ISSUER = 'https://auth.example.test';

/** A fetch that answers by URL; anything else fails the test. */
function routes(table: Record<string, () => Response>) {
  return (async (url: string) => {
    const handler = table[url];
    if (!handler) throw new Error(`unexpected fetch ${url}`);
    return handler();
  }) as unknown as typeof fetch;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function jwt(key: KeyObject, alg: 'RS256' | 'ES256', claims: Record<string, unknown>, kid = 'k1') {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg, kid });
  const body = enc(claims);
  const data = Buffer.from(`${head}.${body}`);
  const sig = alg === 'ES256' ? sign('sha256', data, { key, dsaEncoding: 'ieee-p1363' }) : sign('sha256', data, key);
  return `${head}.${body}.${sig.toString('base64url')}`;
}

describe('Sign in with ChatGPT: OAuth pieces', () => {
  it('builds the authorize URL: the name hint only with the dynamic client', () => {
    const p = { hostId: 'urn:uuid:h', redirectUri: 'http://127.0.0.1:7400/auth/chatgpt/callback', state: 's', nonce: 'n', challenge: 'c', agentName: 'PantryMos' };
    const first = new URL(authorizeUrl(ENDPOINTS, { ...p, clientId: 'dynamic_agent_client' }));
    expect(first.origin + first.pathname).toBe('https://auth.example.test/api/accounts/authorize');
    expect(first.searchParams.get('agent_name_hint')).toBe('PantryMos');
    const again = new URL(authorizeUrl(ENDPOINTS, { ...p, clientId: 'oaiapp_1' }));
    expect(again.searchParams.has('agent_name_hint')).toBe(false);
    const { verifier, challenge } = pkce();
    expect(verifier).toMatch(/^[\w-]{43}$/);
    expect(challenge).not.toBe(verifier);
  });

  it('tells a terminal refresh error from a temporary one, in either error shape', async () => {
    const fail = (status: number, body: unknown) => refreshTokens(ENDPOINTS, { clientId: 'c', refreshToken: 'r' }, routes({ 'https://auth.example.test/api/accounts/oauth/token': () => json(body, status) }));
    await expect(fail(400, { error: 'invalid_grant' })).rejects.toMatchObject({ terminal: true, code: 'invalid_grant' });
    await expect(fail(401, { error: { code: 'refresh_token_reused' } })).rejects.toMatchObject({ terminal: true });
    await expect(fail(503, { error: 'temporarily_unavailable' })).rejects.toMatchObject({ terminal: false, status: 503 });
    const err = await fail(200, { refresh_token: 'only' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as Error).message).not.toContain('only');
  });

  it('checks an ID token: RS256 and ES256 signatures, issuer, audience, expiry, nonce', async () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const fetchImpl = (issuer = ISSUER) =>
      routes({
        'https://auth.example.test/.well-known/openid-configuration': () => json({ issuer, jwks_uri: 'https://auth.example.test/jwks' }),
        'https://auth.example.test/jwks': () =>
          json({ keys: [{ ...rsa.publicKey.export({ format: 'jwk' }), kid: 'k1' }, { ...ec.publicKey.export({ format: 'jwk' }), kid: 'k2' }] }),
      });
    const now = Date.now();
    const claims = { iss: ISSUER, aud: ['oaiapp_1'], sub: 'user-1', email: 'a@b.c', nonce: 'n1', exp: Math.floor(now / 1000) + 60 };
    const check = (token: string, expected: { clientId: string; nonce?: string } = { clientId: 'oaiapp_1', nonce: 'n1' }, f = fetchImpl()) =>
      verifyIdToken(ENDPOINTS, token, expected, f, now);

    expect(await check(jwt(rsa.privateKey, 'RS256', claims))).toEqual({ sub: 'user-1', email: 'a@b.c' });
    expect(await check(jwt(ec.privateKey, 'ES256', { ...claims, email: undefined }, 'k2'), { clientId: 'oaiapp_1' })).toEqual({ sub: 'user-1' });

    await expect(check(jwt(rsa.privateKey, 'RS256', claims), { clientId: 'oaiapp_other', nonce: 'n1' })).rejects.toThrow(/audience/);
    await expect(check(jwt(rsa.privateKey, 'RS256', { ...claims, exp: Math.floor(now / 1000) - 1 }))).rejects.toThrow(/expired/);
    await expect(check(jwt(rsa.privateKey, 'RS256', { ...claims, nonce: 'n0' }))).rejects.toThrow(/nonce/);
    await expect(check(jwt(rsa.privateKey, 'RS256', { ...claims, iss: 'https://evil.test' }))).rejects.toThrow(/issuer is wrong/);
    await expect(check(jwt(rsa.privateKey, 'RS256', { ...claims, sub: '' }))).rejects.toThrow(/subject/);
    await expect(check(jwt(rsa.privateKey, 'RS256', claims, 'k9'))).rejects.toThrow(/not in the JWKS/);
    await expect(check(jwt(ec.privateKey, 'ES256', claims, 'k1'))).rejects.toThrow(/signature/);
    await expect(check('not.a-jwt')).rejects.toThrow();
    await expect(check(jwt(rsa.privateKey, 'RS256', claims), undefined, fetchImpl('https://elsewhere.test'))).rejects.toThrow(/issuer does not match/);
  });

  it('lists only the models meant to be shown, in the server order', async () => {
    const f = routes({
      'https://api.example.test/v1/models': () =>
        json({ models: [{ slug: 'b', display_name: 'B', visibility: 'list' }, { slug: 'h', visibility: 'hide' }, { slug: 'a', visibility: 'list' }] }),
    });
    expect(await listModels(ENDPOINTS, 'tok', f)).toEqual([{ slug: 'b', display_name: 'B' }, { slug: 'a', display_name: 'a' }]);
    await expect(listModels(ENDPOINTS, 'tok', routes({ 'https://api.example.test/v1/models': () => json({}, 401) }))).rejects.toThrow(/401/);
  });

  it('reports a revocation it could not confirm', async () => {
    const discovery = (body: unknown) => () => json(body);
    expect(await revoke(ENDPOINTS, { clientId: 'c', refreshToken: 'r' }, routes({ 'https://auth.example.test/.well-known/openid-configuration': discovery({ issuer: ISSUER, jwks_uri: 'x' }) }))).toBe(false);
    expect(
      await revoke(
        ENDPOINTS,
        { clientId: 'c', refreshToken: 'r' },
        routes({
          'https://auth.example.test/.well-known/openid-configuration': discovery({ issuer: ISSUER, jwks_uri: 'x', revocation_endpoint: 'https://auth.example.test/revoke' }),
          'https://auth.example.test/revoke': () => new Response('', { status: 500 }),
        }),
      ),
    ).toBe(false);
    expect(await revoke(ENDPOINTS, { clientId: 'c', refreshToken: 'r' }, routes({}))).toBe(false);
  });
});
