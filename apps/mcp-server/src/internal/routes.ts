// Internal API routes (§4.3, §4.4). Reachable only on the internal listener, behind the service token.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ConfirmBody, confirmProposal } from '../commit/confirm.ts';
import { EditBody, editProposal, RegenerateBody, regenerateProposal } from '../commit/edit.ts';
import { notFound, proposalHousehold } from '../commit/lock.ts';
import { proposalView } from '../db/proposals.ts';
import { RejectBody, rejectProposal } from '../commit/reject.ts';
import type { Config } from '../config.ts';
import type { Pool } from '../db/pool.ts';
import type { Outcome } from '../db/requestLog.ts';
import { householdExists, inventoryView, ledgerView, pendingView } from './views.ts';

const ProposalParams = z.object({ id: z.uuid() });
const HouseholdHeader = z.object({ 'x-household-id': z.uuid() });
const LedgerQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });

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

  // The card as it stands, for the agent to read back or to find the proposal's conversation (§8.5, §8.8).
  app.get('/internal/proposals/:id', async (request, reply) => {
    const params = ProposalParams.safeParse(request.params);
    const view = params.success ? await proposalView(pool, params.data.id) : null;
    return view ? reply.send(view) : reply.code(404).send(notFound().body);
  });

  /**
   * §11.3: a view names its household in a header. The service token is trusted with every
   * household the agent serves (as for proposals, whose household comes from the row).
   */
  const view =
    <Q extends z.ZodType>(Query: Q, read: (householdId: string, query: z.infer<Q>) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const header = HouseholdHeader.safeParse(request.headers);
      const query = Query.safeParse(request.query);
      if (!header.success || !query.success) {
        return reply
          .code(400)
          .send({ error: 'bad_request', issues: [...(header.error?.issues ?? []), ...(query.error?.issues ?? [])] });
      }
      const householdId = header.data['x-household-id'];
      if (!(await householdExists(pool, householdId))) return reply.code(404).send({ error: 'not_found' });
      return reply.send(await read(householdId, query.data));
    };

  app.get('/internal/views/inventory', view(z.object({}), (householdId) => inventoryView(pool, householdId)));
  app.get('/internal/views/ledger', view(LedgerQuery, (householdId, { limit }) => ledgerView(pool, householdId, limit)));
  app.get('/internal/views/pending', view(z.object({}), (householdId) => pendingView(pool, householdId)));

  app.post('/internal/proposals/:id/reject', action(RejectBody, (id, body) => rejectProposal(pool, id, body)));
  app.patch('/internal/proposals/:id', action(EditBody, (id, body) => editProposal(pool, id, body)));
  app.post('/internal/proposals/:id/regenerate', action(RegenerateBody, (id, body) => regenerateProposal(pool, id, body)));
}
