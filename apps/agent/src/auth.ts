// Sign-in for the web app (IMPLEMENTATION_PLAN §11.4, S8): the session cookie and the Origin check.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AgentConfig } from './config.ts';
import { issueSession, readCookie, SESSION_COOKIE, safeEqual, sessionCookie, verifySession } from './session.ts';

const SessionBody = z.object({ passcode: z.string().max(200).optional() }).default({});

/** /api routes that need no session: the health check and signing in. */
const PUBLIC = new Set(['GET /api/health', 'GET /api/session', 'POST /api/session']);

const pathOf = (request: FastifyRequest) => request.url.split('?')[0]!;

export function signedInUser(request: FastifyRequest, config: AgentConfig): string | null {
  const user = verifySession(config.session.secret, readCookie(request.headers.cookie, SESSION_COOKIE));
  return user === config.userId ? user : null;
}

export function registerAuth(app: FastifyInstance, config: AgentConfig): void {
  app.addHook('onRequest', async (request, reply) => {
    const path = pathOf(request);
    if (!path.startsWith('/api/')) return;
    // State-changing routes only from the app's own origin.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const origin = request.headers.origin;
      if (!origin || !config.appOrigins.includes(origin)) return reply.code(403).send({ error: 'forbidden_origin' });
    }
    if (!PUBLIC.has(`${request.method} ${path}`) && !signedInUser(request, config)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/api/session', async (request, reply) =>
    reply.send({ user_id: signedInUser(request, config), passcode_required: config.session.passcode !== undefined }),
  );

  /** Locally (no passcode configured) anyone reaching the app signs in as the demo user. */
  app.post(
    '/api/session',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = SessionBody.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
      const { passcode } = config.session;
      if (passcode !== undefined && !safeEqual(parsed.data.passcode ?? '', passcode)) {
        return reply.code(401).send({ error: 'wrong_passcode' });
      }
      const value = issueSession(config.session.secret, config.userId, config.session.ttlSeconds);
      return reply
        .header('set-cookie', sessionCookie(value, { maxAgeSeconds: config.session.ttlSeconds, secure: config.session.secureCookie }))
        .send({ user_id: config.userId });
    },
  );
}
