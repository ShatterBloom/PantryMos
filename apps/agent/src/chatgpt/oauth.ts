// The OAuth side of Sign in with ChatGPT for open-source apps (developers.openai.com/siwc,
// "Registration and sign-in", "Accounts and sessions"): PKCE with a loopback redirect, dynamic client
// registration on the first sign-in, rotating refresh tokens, and ID token checks against the JWKS.
import { createHash, createPublicKey, type JsonWebKey, randomBytes, verify } from 'node:crypto';

export const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
/** Without this granted scope, a sign-in proves who the user is but can't use their plan. */
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
/** The client id of a first sign-in; the callback returns the one OpenAI issued. */
export const DYNAMIC_CLIENT = 'dynamic_agent_client';

export interface OAuthEndpoints {
  /** `https://auth.openai.com`; also the ID token issuer. */
  authUrl: string;
  /** `https://api.openai.com/v1`: the resource the tokens are for. */
  apiUrl: string;
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
}

/** A refusal from the token endpoint; `terminal` means the refresh token can't be used again. */
export class OAuthError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly terminal: boolean;

  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.name = 'OAuthError';
    this.status = status;
    this.code = code;
    this.terminal = code !== undefined && TERMINAL.has(code);
  }
}

/** "Errors and recovery": refresh errors after which only a new sign-in helps. */
const TERMINAL = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);

const b64url = (data: Buffer) => data.toString('base64url');
export const randomToken = () => b64url(randomBytes(32));

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomToken();
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

export interface AuthorizeParams {
  clientId: string;
  hostId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  challenge: string;
  /** Sent on the first registration only. */
  agentName?: string;
}

export function authorizeUrl(endpoints: OAuthEndpoints, p: AuthorizeParams): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: p.clientId,
    ...(p.clientId === DYNAMIC_CLIENT && p.agentName ? { agent_name_hint: p.agentName } : {}),
    ext_agent_host_id: p.hostId,
    redirect_uri: p.redirectUri,
    scope: SCOPES,
    resource: endpoints.apiUrl,
    state: p.state,
    nonce: p.nonce,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
  });
  return `${trim(endpoints.authUrl)}/api/accounts/authorize?${params}`;
}

const trim = (url: string) => url.replace(/\/+$/, '');

async function tokenRequest(endpoints: OAuthEndpoints, form: Record<string, string>, fetchImpl: typeof fetch): Promise<TokenSet> {
  const res = await fetchImpl(`${trim(endpoints.authUrl)}/api/accounts/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...form, resource: endpoints.apiUrl }),
    signal: AbortSignal.timeout(30_000),
  });
  const raw = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // not JSON: the status says enough
  }
  if (!res.ok || typeof body.access_token !== 'string') {
    // Standard OAuth ({"error": "invalid_grant"}) or OpenAI's ({"error": {"code": …}}).
    const error = body.error as string | { code?: string } | undefined;
    const code = typeof error === 'string' ? error : error?.code;
    // The body is never logged whole: a 200 without an access token could still hold other tokens.
    throw new OAuthError(res.status, code, `Token request failed: ${res.status} ${code ?? ''}`.trim());
  }
  return body as unknown as TokenSet;
}

export function exchangeCode(
  endpoints: OAuthEndpoints,
  p: { clientId: string; code: string; verifier: string; redirectUri: string },
  fetchImpl: typeof fetch = fetch,
): Promise<TokenSet> {
  return tokenRequest(endpoints, { grant_type: 'authorization_code', client_id: p.clientId, code: p.code, code_verifier: p.verifier, redirect_uri: p.redirectUri }, fetchImpl);
}

/** Leaves `scope` out, which keeps the grant as it was. */
export function refreshTokens(endpoints: OAuthEndpoints, p: { clientId: string; refreshToken: string }, fetchImpl: typeof fetch = fetch): Promise<TokenSet> {
  return tokenRequest(endpoints, { grant_type: 'refresh_token', client_id: p.clientId, refresh_token: p.refreshToken }, fetchImpl);
}

interface Discovery {
  issuer: string;
  jwks_uri: string;
  revocation_endpoint?: string;
}

async function discovery(endpoints: OAuthEndpoints, fetchImpl: typeof fetch): Promise<Discovery> {
  const res = await fetchImpl(`${trim(endpoints.authUrl)}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`OpenID discovery failed: ${res.status}`);
  return (await res.json()) as Discovery;
}

/** Revokes the refresh token; true once the server confirmed it (an already invalid token counts). */
export async function revoke(endpoints: OAuthEndpoints, p: { clientId: string; refreshToken: string }, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const { revocation_endpoint } = await discovery(endpoints, fetchImpl);
    if (!revocation_endpoint) return false;
    const res = await fetchImpl(revocation_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: p.refreshToken, token_type_hint: 'refresh_token', client_id: p.clientId }),
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface IdentityClaims {
  sub: string;
  email?: string;
}

/**
 * Checks an ID token's signature against the issuer's JWKS, and its issuer, audience (the issued
 * client id), expiry and nonce. Returns the identity it names.
 */
export async function verifyIdToken(
  endpoints: OAuthEndpoints,
  idToken: string,
  expected: { clientId: string; nonce?: string },
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<IdentityClaims> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('ID token is not a JWT');
  const [head, payload, signature] = parts as [string, string, string];
  const header = JSON.parse(Buffer.from(head, 'base64url').toString()) as { alg?: string; kid?: string };
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;

  const meta = await discovery(endpoints, fetchImpl);
  if (trim(meta.issuer) !== trim(endpoints.authUrl)) throw new Error('OpenID issuer does not match the configured auth URL');
  const res = await fetchImpl(meta.jwks_uri, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`JWKS request failed: ${res.status}`);
  const { keys } = (await res.json()) as { keys: Array<JsonWebKey & { kid?: string }> };
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('ID token key is not in the JWKS');
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  const data = Buffer.from(`${head}.${payload}`);
  const sig = Buffer.from(signature, 'base64url');
  const valid =
    header.alg === 'RS256' ? verify('sha256', data, key, sig)
    : header.alg === 'ES256' ? verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig)
    : false;
  if (!valid) throw new Error('ID token signature is invalid');

  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== meta.issuer) throw new Error('ID token issuer is wrong');
  if (!aud.includes(expected.clientId)) throw new Error('ID token audience is not this client');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) throw new Error('ID token has expired');
  if (expected.nonce !== undefined && claims.nonce !== expected.nonce) throw new Error('ID token nonce does not match');
  if (typeof claims.sub !== 'string' || claims.sub === '') throw new Error('ID token has no subject');
  return { sub: claims.sub, ...(typeof claims.email === 'string' ? { email: claims.email } : {}) };
}

export interface PlanModel {
  slug: string;
  display_name: string;
}

/** The plan's model catalog ("Models and inference"): listed models, in the server's order. */
export async function listModels(endpoints: OAuthEndpoints, accessToken: string, fetchImpl: typeof fetch = fetch): Promise<PlanModel[]> {
  const res = await fetchImpl(`${trim(endpoints.apiUrl)}/models`, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Model catalog request failed: ${res.status}`);
  const { models } = (await res.json()) as { models?: Array<{ slug?: string; display_name?: string; visibility?: string }> };
  return (models ?? []).flatMap((m) => (m.visibility === 'list' && m.slug ? [{ slug: m.slug, display_name: m.display_name ?? m.slug }] : []));
}
