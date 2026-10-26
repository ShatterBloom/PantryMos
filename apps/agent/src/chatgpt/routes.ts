// The app's view of the models: which are configured, choosing one, and Sign in with ChatGPT
// (start, callback, welcome notice, sign-out).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PROVIDERS, type Provider } from '../config.ts';
import type { ModelChoice } from '../model/choice.ts';
import type { ChatGPTAccount } from './account.ts';

export interface ModelRoutesOptions {
  choice: ModelChoice;
  /** Each configured provider's model id as the app shows it (null: a ChatGPT plan's default). */
  modelIds: ReadonlyMap<Provider, string | null>;
  /** Null unless a ChatGPT plan is one of the models. */
  account: ChatGPTAccount | null;
  /** Where the browser goes after the callback, with `?chatgpt=<result>`. */
  returnUrl: string;
}

const ChoiceBody = z.object({ provider: z.enum(PROVIDERS) });

export function registerModelRoutes(app: FastifyInstance, { choice, modelIds, account, returnUrl }: ModelRoutesOptions): void {
  // Every provider, so the app can show the ones not set up too.
  const status = async () => ({
    current: await choice.current(),
    models: PROVIDERS.map((provider) => ({ provider, configured: modelIds.has(provider), model: modelIds.get(provider) ?? null })),
    chatgpt: account ? await account.status() : null,
  });

  app.get('/api/model', async (_request, reply) => reply.send(await status()));

  app.post('/api/model/choice', async (request, reply) => {
    const parsed = ChoiceBody.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    if (!(await choice.choose(parsed.data.provider))) {
      return reply.code(409).send({ code: 'model_not_configured', message: `${parsed.data.provider} isn't set up in MODEL_PROVIDERS.` });
    }
    return reply.send(await status());
  });

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
