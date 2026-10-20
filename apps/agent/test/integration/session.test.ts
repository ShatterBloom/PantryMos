// S8 (§9.2, §11.4): /api needs the session cookie, and state-changing routes the app's Origin.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type RunningServers, startServers } from '@pantrymos/mcp-server';
import { issueSession } from '../../src/session.ts';
import { createDemoKitchen, type DemoKitchen, mcpTestConfig } from '../../../../test/fixtures.ts';
import { APP_ORIGIN, say, signIn, startAgent, TEST_SESSION_SECRET, type TestAgent } from '../fixtures.ts';

describe('S8: sessions and origins', () => {
  let servers: RunningServers;
  beforeAll(async () => {
    servers = await startServers(mcpTestConfig(), { log: false });
  });
  afterAll(async () => servers.close());

  let kitchen: DemoKitchen;
  let agent: TestAgent;
  beforeEach(async () => {
    kitchen = await createDemoKitchen();
    agent = await startAgent(servers, kitchen);
  });
  afterEach(async () => agent.close());

  const chatPayload = () => ({ conversation_id: agent.conversationId, request_id: randomUUID(), text: 'hi', input_mode: 'text' });
  const status = async (headers: Record<string, string>, method: 'GET' | 'POST' = 'POST') =>
    (
      await agent.app.inject(
        method === 'POST'
          ? { method, url: '/api/chat', headers, payload: chatPayload() }
          : { method, url: `/api/messages?conversation_id=${agent.conversationId}`, headers },
      )
    ).statusCode;

  it('refuses /api without a valid session cookie', async () => {
    expect(await status({ origin: APP_ORIGIN })).toBe(401);
    expect(await status({}, 'GET')).toBe(401);
    const forged = issueSession('another-secret-0123456789abcdefghij', 'demo', 3600);
    expect(await status({ origin: APP_ORIGIN, cookie: `pm_session=${forged}` })).toBe(401);
    const expired = issueSession(TEST_SESSION_SECRET, 'demo', 60, Date.now() - 3_600_000);
    expect(await status({ origin: APP_ORIGIN, cookie: `pm_session=${expired}` })).toBe(401);
    const otherUser = issueSession(TEST_SESSION_SECRET, 'someone-else', 3600);
    expect(await status({ origin: APP_ORIGIN, cookie: `pm_session=${otherUser}` })).toBe(401);
    expect(await status({ origin: APP_ORIGIN, cookie: `pm_session=${agent.cookie.split('=')[1]}x` })).toBe(401);
    expect(await status({ origin: APP_ORIGIN, cookie: 'pm_session=a.b' })).toBe(401);
    // The health check and signing in need none.
    expect((await agent.app.inject({ method: 'GET', url: '/api/health' })).statusCode).not.toBe(401);
    expect((await agent.app.inject({ method: 'GET', url: '/api/session' })).json()).toEqual({ user_id: null, passcode_required: false });
  });

  it('refuses state-changing requests from another origin, even with the cookie', async () => {
    expect(await status({ cookie: agent.cookie })).toBe(403);
    expect(await status({ cookie: agent.cookie, origin: 'https://evil.example' })).toBe(403);
    expect((await agent.app.inject({ method: 'POST', url: '/api/session', headers: { origin: 'https://evil.example' } })).statusCode).toBe(403);
    agent.model.push(say('Hi.'));
    expect(await status({ cookie: agent.cookie, origin: APP_ORIGIN })).toBe(200);
    expect(await status({ cookie: `theme=dark; ${agent.cookie}` }, 'GET')).toBe(200);
  });

  it('signs in locally without a passcode, with a strict HttpOnly cookie', async () => {
    const res = await agent.app.inject({ method: 'POST', url: '/api/session', headers: { origin: APP_ORIGIN } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user_id: 'demo' });
    expect(res.headers['set-cookie']).toMatch(/^pm_session=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=3600$/);
    expect((await agent.api({ method: 'GET', url: '/api/session' })).json()).toEqual({ user_id: 'demo', passcode_required: false });
  });

  it('needs the passcode when one is set, and marks the cookie Secure when asked', async () => {
    const guarded = await startAgent(servers, kitchen, {
      config: { session: { secret: TEST_SESSION_SECRET, passcode: 'open-sesame', secureCookie: true, ttlSeconds: 600 } },
    });
    try {
      const signInWith = (payload: unknown) =>
        guarded.app.inject({ method: 'POST', url: '/api/session', headers: { origin: APP_ORIGIN }, payload: payload as object });
      expect((await guarded.app.inject({ method: 'GET', url: '/api/session' })).json()).toEqual({ user_id: null, passcode_required: true });
      expect((await signInWith({})).statusCode).toBe(401);
      expect((await signInWith({ passcode: 'open-sesamE' })).statusCode).toBe(401);
      expect((await signInWith({ passcode: 42 })).statusCode).toBe(400);
      const ok = await signInWith({ passcode: 'open-sesame' });
      expect(ok.statusCode).toBe(200);
      expect(ok.headers['set-cookie']).toMatch(/; Max-Age=600; Secure$/);
      expect(await signIn(guarded.app, 'open-sesame')).toMatch(/^pm_session=/);
    } finally {
      await guarded.close();
    }
  });
});
