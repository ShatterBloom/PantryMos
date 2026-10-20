// Internal API routes (§4.3, §4.4). Reachable only on the internal listener, behind the service token.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ConfirmBody, confirmProposal } from '../commit/confirm.ts';
import { proposalHousehold } from '../commit/lock.ts';
import { RejectBody, rejectProposal } from '../commit/reject.ts';
import type { Config } from '../config.ts';
import type { Pool } from '../db/pool.ts';
import type { Outcome } from '../db/requestLog.ts';

const ProposalParams = z.object({ id: z.uuid() });

export function registerInternalRoutes(app: FastifyInstance, pool: Pool, config: Config): void {
  /** Parses params and body with zod, runs the action, and replies with its stored outcome. */
  const action =
    <B extends z.ZodType>(Body: B, run: (proposalId: string, body: z.infer<B>) => Promise<Outcome>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = ProposalParams.safeParse(request.params);
      const body = Body.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply
          .code(400)
          .send({ error: 'bad_request', issues: [...(params.error?.issues ?? []), ...(body.error?.issues ?? [])] });
      }
      const outcome = await run(params.data.id, body.data);
      return reply.code(outcome.status).send(outcome.body);
    };

  app.post(
    '/internal/proposals/:id/confirm',
    {
      config: {
        // §11.5: confirm is limited per household, whichever app or channel it comes from.
        rateLimit: {
          max: config.confirmRatePerMinute,
          timeWindow: '1 minute',
          keyGenerator: async (request: FastifyRequest) => {
            const params = ProposalParams.safeParse(request.params);
            const household = params.success ? await proposalHousehold(pool, params.data.id) : null;
            return household ? `confirm:${household}` : `confirm-ip:${request.ip}`;
          },
        },
      },
    },
    action(ConfirmBody, (id, body) => confirmProposal(pool, id, body)),
  );

  app.post('/internal/proposals/:id/reject', action(RejectBody, (id, body) => rejectProposal(pool, id, body)));
}
