// The app's view of the model, and Sign in with ChatGPT: start, callback, welcome notice, sign-out.
import type { FastifyInstance } from 'fastify';
import type { ChatGPTAccount } from './account.ts';

export interface ModelRoutesOptions {
  provider: string;
  /** Null unless the agent runs on a ChatGPT plan. */
  account: ChatGPTAccount | null;
  /** Where the browser goes after the callback, with `?chatgpt=<result>`. */
  returnUrl: string;
}

export function registerModelRoutes(app: FastifyInstance, { provider, account, returnUrl }: ModelRoutesOptions): void {
  app.get('/api/model', async (_request, reply) => reply.send({ provider, chatgpt: account ? await account.status() : null }));

  if (!account) return;

  app.post('/api/model/chatgpt/sign-in', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (_request, reply) =>
    reply.send({ authorize_url: await account.start() }),
  );

  app.post('/api/model/chatgpt/welcomed', async (_request, reply) => {
    await account.markWelcomed();
    return reply.code(204).send();
  });

  app.post('/api/model/chatgpt/sign-out', async (_request, reply) => reply.send(await account.signOut()));

  // Outside /api: the browser arrives here from OpenAI, maybe on another host name than the app's
  // (127.0.0.1, not localhost), so without the session cookie. The one-time state is what binds it.
  app.get(
    '/auth/chatgpt/callback',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      let result: Awaited<ReturnType<ChatGPTAccount['complete']>>;
      try {
        result = await account.complete(request.query as Record<string, string | undefined>);
      } catch (err) {
        request.log.error({ err }, 'ChatGPT sign-in failed');
        result = 'failed';
      }
      const target = new URL(returnUrl);
      target.searchParams.set('chatgpt', result);
      return reply.redirect(target.toString(), 303);
    },
  );
}
