// Sign in with ChatGPT end to end against a fake OpenAI (auth server, JWKS, model catalog, Responses
// stream): sign-in and its checks, a turn on the plan, token refresh, plan errors, and sign-out.
import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type RunningServers, startServers } from '@pantrymos/mcp-server';
import { TEST_AGENT_DB_URL } from '../../../../test/env.ts';
import { createDemoKitchen, type DemoKitchen, mcpTestConfig, stockKitchen } from '../../../../test/fixtures.ts';
import { ChatGPTAccount } from '../../src/chatgpt/account.ts';
import { TokenSealer } from '../../src/chatgpt/sealing.ts';
import type { ModelConfig } from '../../src/config.ts';
import { createPool, type Pool } from '../../src/db.ts';
import { ChatGPTPlanModel } from '../../src/model/responses.ts';
import { chat, lastMessage, startAgentWith, type TestAgent } from '../fixtures.ts';

const CALLBACK = 'http://127.0.0.1:7400/auth/chatgpt/callback';
const RETURN = 'http://localhost:7400/';
const TOKEN_KEY = 'chatgpt-token-key-for-tests-0123456789';
const PLAN = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  form: URLSearchParams;
  json: Record<string, unknown> | null;
}

/** A fake auth.openai.com plus api.openai.com/v1 on one port; each test scripts what it needs. */
class FakeOpenAI {
  server!: Server;
  base = '';
  readonly seen: Seen[] = [];
  readonly keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  /** The PKCE challenge from the authorize URL, checked against the verifier at the token endpoint. */
  challenge = '';
  nonce = '';
  issuedClient = 'oaiapp_test1';
  idTokenOverrides: Record<string, unknown> = {};
  signWith: KeyObject = this.keys.privateKey;
  grantedScope = PLAN;
  refreshReply: () => [number, unknown] = () => [200, { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 }];
  responses: Array<() => [number, unknown[] | unknown]> = [];
  revoked: string[] = [];
  counter = 0;

  async start() {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => this.handle(req, res, raw));
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  idToken(claims: Record<string, unknown> = {}) {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const head = enc({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
    const body = enc({
      iss: this.base,
      aud: this.issuedClient,
      sub: 'user-1',
      email: 'cook@example.com',
      nonce: this.nonce,
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...this.idTokenOverrides,
      ...claims,
    });
    return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), this.signWith).toString('base64url')}`;
  }

  private send(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  }

  private handle(req: IncomingMessage, res: ServerResponse, raw: string) {
    const path = (req.url ?? '').split('?')[0]!;
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(raw);
    } catch {
      // a form or nothing
    }
    const form = new URLSearchParams(raw);
    this.seen.push({ method: req.method ?? '', path, headers: req.headers, form, json });
    switch (`${req.method} ${path}`) {
      case 'GET /.well-known/openid-configuration':
        return this.send(res, 200, { issuer: this.base, jwks_uri: `${this.base}/jwks`, revocation_endpoint: `${this.base}/revoke` });
      case 'GET /jwks':
        return this.send(res, 200, { keys: [{ ...this.keys.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] });
      case 'POST /api/accounts/oauth/token': {
        if (form.get('resource') !== `${this.base}/v1`) return this.send(res, 400, { error: 'invalid_target' });
        if (form.get('grant_type') === 'authorization_code') {
          const verified = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === this.challenge;
          if (!verified || form.get('code') !== 'code-1' || form.get('client_id') !== this.issuedClient || form.get('redirect_uri') !== CALLBACK) {
            return this.send(res, 400, { error: 'invalid_grant' });
          }
          return this.send(res, 200, { access_token: 'access-1', refresh_token: 'refresh-1', id_token: this.idToken(), expires_in: 3600, scope: this.grantedScope, token_type: 'Bearer' });
        }
        if (form.get('grant_type') === 'refresh_token') {
          this.counter++;
          const [status, body] = this.refreshReply();
          // Slow enough that concurrent requests all find the token expiring.
          setTimeout(() => this.send(res, status, body), 200);
          return;
        }
        return this.send(res, 400, { error: 'unsupported_grant_type' });
      }
      case 'POST /revoke':
        this.revoked.push(form.get('token') ?? '');
        return res.writeHead(200).end();
      case 'GET /v1/models':
        return this.send(res, 200, {
          models: [
            { slug: 'gpt-hidden', display_name: 'Hidden', visibility: 'hide' },
            { slug: 'gpt-plan-1', display_name: 'Plan One', visibility: 'list' },
            { slug: 'gpt-plan-2', display_name: 'Plan Two', visibility: 'list' },
          ],
        });
      case 'POST /v1/responses': {
        const next = this.responses.shift();
        if (!next) return this.send(res, 500, { error: { code: 'unscripted' } });
        const [status, body] = next();
        if (status !== 200) return this.send(res, status, body);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const event of body as unknown[]) res.write(`data: ${JSON.stringify(event)}\n\n`);
        return res.end();
      }
      default:
        return this.send(res, 404, {});
    }
  }
}

// As ChatGPT's backend streams it: each item on its own, the completed response's output empty.
const completed = (output: unknown[]) => [
  ...output.map((item, i) => ({ type: 'response.output_item.done', output_index: i, item })),
  { type: 'response.completed', response: { output: [], usage: { input_tokens: 5, output_tokens: 1 } } },
];
const text = (t: string) => completed([{ type: 'message', content: [{ type: 'output_text', text: t }] }]);

describe('a ChatGPT plan through Sign in with ChatGPT', () => {
  let servers: RunningServers;
  const fake = new FakeOpenAI();
  beforeAll(async () => {
    servers = await startServers(mcpTestConfig(), { log: false });
    await fake.start();
  });
  afterAll(async () => {
    await new Promise((resolve) => fake.server.close(resolve));
    await servers.close();
  });

  let kitchen: DemoKitchen;
  let agent: TestAgent<ChatGPTPlanModel>;
  let account: ChatGPTAccount;
  let pool: Pool;
  beforeEach(async () => {
    Object.assign(fake, { challenge: '', nonce: '', issuedClient: 'oaiapp_test1', idTokenOverrides: {}, signWith: fake.keys.privateKey, grantedScope: PLAN, responses: [], revoked: [], counter: 0 });
    fake.refreshReply = () => [200, { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 }];
    fake.seen.length = 0;
    kitchen = await createDemoKitchen();
    const settings = { tokenKey: TOKEN_KEY, callbackUrl: CALLBACK, authUrl: fake.base, apiUrl: `${fake.base}/v1`, maxTokens: 1024, timeoutMs: 5000 };
    const model: ModelConfig = { provider: 'chatgpt', ...settings, returnUrl: RETURN };
    pool = createPool(TEST_AGENT_DB_URL);
    await pool.query('DELETE FROM agent.chatgpt_session');
    await pool.query('DELETE FROM agent.chatgpt_sign_ins');
    await pool.query('DELETE FROM agent.chatgpt_registration');
    account = new ChatGPTAccount(pool, settings);
    agent = await startAgentWith(new ChatGPTPlanModel({ ...settings, retryDelaysMs: [1] }, account), servers, kitchen, { config: { models: [model] }, chatgpt: account });
  });
  afterEach(async () => {
    await agent.close();
    await pool.end();
  });

  /** Starts a sign-in from the app and returns the authorize URL's parameters. */
  const startSignIn = async () => {
    const res = await agent.api({ method: 'POST', url: '/api/model/chatgpt/sign-in' });
    expect(res.statusCode).toBe(200);
    const url = new URL(res.json().authorize_url as string);
    fake.challenge = url.searchParams.get('code_challenge')!;
    fake.nonce = url.searchParams.get('nonce')!;
    return url;
  };
  /** The browser coming back from OpenAI: no session cookie, only the query. */
  const callback = async (query: Record<string, string>) => {
    const res = await agent.app.inject({ method: 'GET', url: `/auth/chatgpt/callback?${new URLSearchParams(query)}` });
    expect(res.statusCode).toBe(303);
    return new URL(res.headers.location as string).searchParams.get('chatgpt');
  };
  const signIn = async () => {
    const url = await startSignIn();
    return callback({ code: 'code-1', state: url.searchParams.get('state')!, client_id: fake.issuedClient, scope: PLAN });
  };
  const status = async () => (await agent.api({ method: 'GET', url: '/api/model' })).json();

  it('signs in: dynamic registration, PKCE, a checked ID token, and the plan default model', async () => {
    expect(await status()).toMatchObject({ current: 'chatgpt', chatgpt: { signed_in: false, email: null, model: null, welcomed: false } });
    const url = await startSignIn();
    expect(`${url.origin}${url.pathname}`).toBe(`${fake.base}/api/accounts/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'dynamic_agent_client',
      agent_name_hint: 'PantryMos',
      redirect_uri: CALLBACK,
      scope: PLAN,
      resource: `${fake.base}/v1`,
      code_challenge_method: 'S256',
    });
    expect(url.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);

    expect(await callback({ code: 'code-1', state: url.searchParams.get('state')!, client_id: fake.issuedClient, scope: PLAN })).toBe('signed_in');
    expect(await status()).toMatchObject({ current: 'chatgpt', chatgpt: { signed_in: true, email: 'cook@example.com', model: 'gpt-plan-1', welcomed: false } });

    // The welcome notice, once per host.
    expect((await agent.api({ method: 'POST', url: '/api/model/chatgpt/welcomed' })).statusCode).toBe(204);
    expect((await status()).chatgpt.welcomed).toBe(true);

    // Signing in again reuses the issued client and the host id, without the name hint.
    const again = await startSignIn();
    expect(again.searchParams.get('client_id')).toBe('oaiapp_test1');
    expect(again.searchParams.has('agent_name_hint')).toBe(false);
    expect(again.searchParams.get('ext_agent_host_id')).toBe(url.searchParams.get('ext_agent_host_id'));
  });

  it('refuses a replayed, denied, foreign or forged callback, and a sign-in without plan usage', async () => {
    const first = await startSignIn();
    const query = { code: 'code-1', state: first.searchParams.get('state')!, client_id: fake.issuedClient, scope: PLAN };
    expect(await callback(query)).toBe('signed_in');
    expect(await callback(query)).toBe('failed'); // the state is used once
    expect(await callback({ ...query, state: 'made-up' })).toBe('failed');

    const denied = await startSignIn();
    expect(await callback({ error: 'access_denied', state: denied.searchParams.get('state')! })).toBe('denied');

    const foreign = await startSignIn();
    expect(await callback({ ...query, state: foreign.searchParams.get('state')!, client_id: 'oaiapp_other' })).toBe('failed');

    // A token from another key, or for another sign-in attempt (nonce).
    fake.signWith = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const forged = await startSignIn();
    expect(await callback({ ...query, state: forged.searchParams.get('state')! })).toBe('failed');
    fake.signWith = fake.keys.privateKey;
    fake.idTokenOverrides = { nonce: 'stale' };
    const replayed = await startSignIn();
    expect(await callback({ ...query, state: replayed.searchParams.get('state')! })).toBe('failed');
    fake.idTokenOverrides = {};

    fake.grantedScope = 'openid profile email offline_access';
    const noPlan = await startSignIn();
    expect(await callback({ ...query, state: noPlan.searchParams.get('state')! })).toBe('no_plan');
  });

  it('runs a turn on the plan: kitchen tools over MCP, the access token as bearer', async () => {
    await stockKitchen(kitchen, { egg: 6 });
    expect(await signIn()).toBe('signed_in');
    fake.responses.push(
      () => [200, completed([{ type: 'function_call', call_id: 'call_1', name: 'list_inventory', arguments: '{}' }])],
      () => [200, text('You have six eggs.')],
    );
    expect((await chat(agent, 'what do I have?')).status).toBe(200);
    expect((await lastMessage(agent)).speech).toBe('You have six eggs.');
    const calls = fake.seen.filter((s) => s.path === '/v1/responses');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers.authorization).toBe('Bearer access-1');
    expect(calls[0]!.json).toMatchObject({ model: 'gpt-plan-1', store: false, stream: true, input: [{ role: 'user', content: 'what do I have?' }] });
    expect((calls[1]!.json!.input as unknown[]).slice(-2)).toEqual([
      { type: 'function_call', call_id: 'call_1', name: 'list_inventory', arguments: '{}' },
      expect.objectContaining({ type: 'function_call_output', call_id: 'call_1' }),
    ]);
  });

  it('refreshes an expiring token once, however many requests need it, and keeps the rotated one', async () => {
    expect(await signIn()).toBe('signed_in');
    await pool.query(`UPDATE agent.chatgpt_session SET expires_at = now() + interval '30 seconds'`);
    const results = await Promise.all(Array.from({ length: 5 }, () => account.current()));
    expect(results.every((r) => r.accessToken === 'access-2')).toBe(true);
    expect(fake.counter).toBe(1);
    const refresh = fake.seen.find((s) => s.form.get('grant_type') === 'refresh_token')!;
    expect(Object.fromEntries(refresh.form)).toEqual({ grant_type: 'refresh_token', client_id: 'oaiapp_test1', refresh_token: 'refresh-1', resource: `${fake.base}/v1` });
    const { rows } = await pool.query(`SELECT refresh_token, expires_at > now() + interval '50 minutes' AS fresh FROM agent.chatgpt_session`);
    expect(rows).toEqual([{ refresh_token: expect.any(String), fresh: true }]);
    expect(new TokenSealer(TOKEN_KEY).open('refresh_token', rows[0].refresh_token)).toBe('refresh-2');
  });

  it('stores the tokens encrypted, and treats tokens it cannot open as signed out', async () => {
    expect(await signIn()).toBe('signed_in');
    const { rows } = await pool.query(`SELECT id_token, access_token, refresh_token FROM agent.chatgpt_session`);
    const stored = JSON.stringify(rows);
    for (const plain of ['access-1', 'refresh-1', 'cook@example.com']) expect(stored).not.toContain(plain);
    expect(rows[0].access_token).toMatch(/^v1\./);

    // The same database under another CHATGPT_TOKEN_KEY: signed out, and the unusable row is cleared.
    const otherKey = new ChatGPTAccount(pool, { tokenKey: 'another-chatgpt-token-key-0123456789', callbackUrl: CALLBACK, authUrl: fake.base, apiUrl: `${fake.base}/v1` });
    expect(await otherKey.status()).toMatchObject({ signed_in: false, email: null, model: null });
    await expect(otherKey.current()).rejects.toMatchObject({ reason: 'signed_out' });
    expect((await pool.query(`SELECT 1 FROM agent.chatgpt_session`)).rowCount).toBe(0);
    expect(fake.counter).toBe(0); // no refresh was tried with what it couldn't read

    // Tampered with in the database: the same.
    expect(await signIn()).toBe('signed_in');
    await pool.query(`UPDATE agent.chatgpt_session SET access_token = refresh_token`);
    expect((await status()).chatgpt.signed_in).toBe(true);
    await expect(account.current()).rejects.toMatchObject({ reason: 'signed_out' });
    expect((await status()).chatgpt.signed_in).toBe(false);
  });

  it('ends the sign-in on a terminal refresh error, and keeps it on a temporary one', async () => {
    expect(await signIn()).toBe('signed_in');
    await pool.query(`UPDATE agent.chatgpt_session SET expires_at = now()`);
    fake.refreshReply = () => [503, { error: 'temporarily_unavailable' }];
    await expect(account.current()).rejects.toThrow(/503/);
    expect((await status()).chatgpt.signed_in).toBe(true);

    fake.refreshReply = () => [400, { error: 'invalid_grant' }];
    const res = await chat(agent, 'hello');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'model_unavailable', reason: 'signed_out' });
    expect((await status()).chatgpt.signed_in).toBe(false);

    // A refresh that comes back without plan usage ends it too.
    expect(await signIn()).toBe('signed_in');
    await pool.query(`UPDATE agent.chatgpt_session SET expires_at = now()`);
    fake.refreshReply = () => [200, { access_token: 'access-3', refresh_token: 'refresh-3', scope: 'openid profile email' }];
    await expect(account.current()).rejects.toMatchObject({ reason: 'signed_out' });
    expect((await status()).chatgpt.signed_in).toBe(false);
  });

  it('answers a chat with model_unavailable when the plan is out of usage, or nobody signed in', async () => {
    let res = await chat(agent, 'hello');
    expect(res.body).toMatchObject({ code: 'model_unavailable', reason: 'signed_out' });
    expect(await signIn()).toBe('signed_in');
    fake.responses.push(() => [429, { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } }]);
    res = await chat(agent, 'hello again');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'model_unavailable', reason: 'usage_limit' });
  });

  it('signs out: revokes the refresh token, forgets the tokens and the issued client', async () => {
    expect(await signIn()).toBe('signed_in');
    const res = await agent.api({ method: 'POST', url: '/api/model/chatgpt/sign-out' });
    expect(res.json()).toEqual({ revoked: true });
    expect(fake.revoked).toEqual(['refresh-1']);
    expect((await status()).chatgpt).toMatchObject({ signed_in: false, email: null });
    // The next sign-in registers again, so another account can sign in.
    expect((await startSignIn()).searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect((await agent.api({ method: 'POST', url: '/api/model/chatgpt/sign-out' })).json()).toEqual({ revoked: true });
  });

  it('keeps the sign-in routes off without a ChatGPT plan configured, and the callback outside the session check', async () => {
    const res = await agent.app.inject({ method: 'GET', url: '/auth/chatgpt/callback?state=x' });
    expect(res.statusCode).toBe(303);
    const other = await startAgentWith(agent.model, servers, kitchen);
    try {
      expect((await other.api({ method: 'GET', url: '/api/model' })).json()).toMatchObject({ current: 'bedrock', chatgpt: null });
      expect((await other.api({ method: 'POST', url: '/api/model/chatgpt/sign-in' })).statusCode).toBe(404);
    } finally {
      await other.close();
    }
  });
});
