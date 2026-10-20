// The internal API client keeps "no such card" apart from a failure, so a fault never reads as a missing card.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InternalClient } from '../../src/internalClient.ts';

describe('InternalClient.view', () => {
  afterEach(() => vi.restoreAllMocks());
  const respond = (status: number, body: unknown = {}) =>
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }));
  const client = new InternalClient('http://127.0.0.1:7411', 'service-token-0123456789');

  it('returns the card, or null when there is none', async () => {
    respond(200, { proposal_id: 'p1', status: 'pending' });
    expect(await client.view('p1')).toEqual({ proposal_id: 'p1', status: 'pending' });
    respond(404, { error: 'not_found' });
    expect(await client.view('p1')).toBeNull();
  });

  it('throws on any other failure, rather than reporting the card gone', async () => {
    respond(500, { error: 'internal_error' });
    await expect(client.view('p1')).rejects.toThrow('Internal proposal view failed with 500');
    respond(401, { error: 'unauthorized' });
    await expect(client.view('p1')).rejects.toThrow(/401/);
  });
});
