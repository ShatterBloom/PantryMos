// The web app's API client: request shapes, errors, and signing in again when the session is gone (§11.4).
import { describe, expect, it } from 'vitest';
import { Api, ApiError } from '../../src/lib/api.ts';

interface Call {
  path: string;
  method: string;
  body: unknown;
}

/** A scripted agent: answers by "METHOD path" and records each call. */
function fakeAgent(routes: Record<string, Array<[number, unknown]> | [number, unknown]>) {
  const calls: Call[] = [];
  const fetch = async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ path, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
    const route = routes[`${method} ${path.split('?')[0]}`];
    if (!route) return new Response('', { status: 404 });
    const [status, body] = Array.isArray(route[0]) ? ((route as Array<[number, unknown]>).shift() ?? [500, {}]) : (route as [number, unknown]);
    return new Response(body === undefined ? '' : JSON.stringify(body), { status });
  };
  return { calls, fetch };
}

let ids = 0;
const newId = () => `id-${++ids}`;

describe('Api', () => {
  it('sends chat, card actions and acks with fresh request ids', async () => {
    const agent = fakeAgent({
      'POST /api/chat': [200, { message_ids: [1] }],
      'POST /api/voice-windows/ack': [200, { window_id: 'w', window_ends_at: '2026-10-21T00:00:30Z' }],
      'POST /api/proposals/p1/confirm': [200, {}],
      'POST /api/proposals/p1/reject': [200, {}],
      'PATCH /api/proposals/p1': [200, {}],
      'POST /api/proposals/p1/regenerate': [200, {}],
    });
    const api = new Api({ fetch: agent.fetch, passcode: async () => null, newId });
    expect(await api.chat('c1', 'hello', 'voice', 'r1')).toEqual({ message_ids: [1] });
    await api.ack('c1', 7);
    await api.confirm('p1', 2);
    await api.reject('p1', 2);
    await api.edit('p1', 2, { delta: -1 });
    await api.regenerate('p1');
    expect(agent.calls).toEqual([
      { path: '/api/chat', method: 'POST', body: { conversation_id: 'c1', request_id: 'r1', text: 'hello', input_mode: 'voice' } },
      { path: '/api/voice-windows/ack', method: 'POST', body: { conversation_id: 'c1', message_id: 7, request_id: expect.stringMatching(/^id-/) } },
      { path: '/api/proposals/p1/confirm', method: 'POST', body: { version: 2, request_id: expect.stringMatching(/^id-/) } },
      { path: '/api/proposals/p1/reject', method: 'POST', body: { version: 2, request_id: expect.stringMatching(/^id-/) } },
      { path: '/api/proposals/p1', method: 'PATCH', body: { base_version: 2, changes: { delta: -1 }, request_id: expect.stringMatching(/^id-/) } },
      { path: '/api/proposals/p1/regenerate', method: 'POST', body: { request_id: expect.stringMatching(/^id-/) } },
    ]);
  });

  it('reads messages, cards, timers, inventory and the ledger', async () => {
    const agent = fakeAgent({
      'GET /api/messages': [200, { messages: [] }],
      'GET /api/proposals/p1': [200, { proposal_id: 'p1' }],
      'GET /api/timers': [200, { timers: [] }],
      'GET /api/inventory': [200, { items: [] }],
      'GET /api/ledger': [200, { operations: [] }],
    });
    const api = new Api({ fetch: agent.fetch, passcode: async () => null, newId });
    await api.messages('c1', 5);
    await api.proposal('p1');
    await api.timers('c1');
    await api.inventory();
    await api.ledger(10);
    expect(agent.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/messages?conversation_id=c1&after=5',
      'GET /api/proposals/p1',
      'GET /api/timers?conversation_id=c1',
      'GET /api/inventory',
      'GET /api/ledger?limit=10',
    ]);
  });

  it('turns an error status into an ApiError with the body', async () => {
    const agent = fakeAgent({ 'POST /api/proposals/p1/confirm': [409, { code: 'stale_state', message: 'Things changed.' }] });
    const api = new Api({ fetch: agent.fetch, passcode: async () => null, newId });
    const err = await api.confirm('p1', 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, message: 'Things changed.', body: { code: 'stale_state' } });
    const bare = await new Api({ fetch: fakeAgent({ 'GET /api/inventory': [502, undefined] }).fetch, passcode: async () => null, newId })
      .inventory()
      .catch((e: unknown) => e);
    expect(bare).toMatchObject({ status: 502, message: 'Request failed (502)' });
  });

  it('signs in when there is no session, locally without a passcode', async () => {
    const agent = fakeAgent({
      'GET /api/session': [200, { user_id: null, passcode_required: false }],
      'POST /api/session': [200, { user_id: 'demo' }],
    });
    await new Api({ fetch: agent.fetch, passcode: async () => 'unused', newId }).ensureSession();
    expect(agent.calls.at(-1)).toEqual({ path: '/api/session', method: 'POST', body: {} });

    const signedIn = fakeAgent({ 'GET /api/session': [200, { user_id: 'demo', passcode_required: false }] });
    await new Api({ fetch: signedIn.fetch, passcode: async () => null, newId }).ensureSession();
    expect(signedIn.calls).toHaveLength(1);
  });

  it('signs in again once when a request finds the session gone, asking for the passcode if needed', async () => {
    const agent = fakeAgent({
      'GET /api/inventory': [
        [401, { error: 'unauthorized' }],
        [200, { items: [] }],
      ],
      'GET /api/ledger': [401, { error: 'unauthorized' }],
      'GET /api/session': [200, { user_id: null, passcode_required: true }],
      'POST /api/session': [200, { user_id: 'demo' }],
    });
    const asked: string[] = [];
    const api = new Api({ fetch: agent.fetch, passcode: async () => (asked.push('asked'), 'open-sesame'), newId });
    expect(await api.inventory()).toEqual({ items: [] });
    expect(agent.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/inventory', 'GET /api/session', 'POST /api/session', 'GET /api/inventory']);
    expect(agent.calls[2]!.body).toEqual({ passcode: 'open-sesame' });
    // Still refused after signing in: give up rather than loop.
    await expect(api.ledger()).rejects.toMatchObject({ status: 401 });
    expect(asked).toHaveLength(2);
  });

  it('stops when the user cancels the passcode, and signs in once for concurrent requests', async () => {
    const cancelled = fakeAgent({ 'GET /api/session': [200, { user_id: null, passcode_required: true }] });
    await expect(new Api({ fetch: cancelled.fetch, passcode: async () => null, newId }).ensureSession()).rejects.toMatchObject({
      status: 401,
      message: 'Sign-in needs the passcode.',
    });

    const agent = fakeAgent({
      'GET /api/inventory': [
        [401, {}],
        [401, {}],
        [200, { items: [] }],
        [200, { items: [] }],
      ],
      'GET /api/session': [200, { user_id: null, passcode_required: false }],
      'POST /api/session': [200, { user_id: 'demo' }],
    });
    const api = new Api({ fetch: agent.fetch, passcode: async () => null, newId });
    await Promise.all([api.inventory(), api.inventory()]);
    expect(agent.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });
});
