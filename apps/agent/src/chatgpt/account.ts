// The agent's ChatGPT sign-in: starting and completing it, keeping its tokens fresh (one refresh at a
// time: the refresh token rotates), and signing out. It is also what the plan model asks for a token.
import { randomUUID } from 'node:crypto';
import { type Pool, withTransaction } from '../db.ts';
import type { PlanCredentials } from '../model/responses.ts';
import { ModelUnavailableError } from '../model/types.ts';
import {
  authorizeUrl,
  DYNAMIC_CLIENT,
  exchangeCode,
  listModels,
  OAuthError,
  type OAuthEndpoints,
  PLAN_SCOPE,
  type PlanModel,
  pkce,
  randomToken,
  refreshTokens,
  revoke,
  verifyIdToken,
} from './oauth.ts';

export interface ChatGPTSettings extends OAuthEndpoints {
  /** `http://127.0.0.1:<port>/auth/chatgpt/callback`: OpenAI accepts only a 127.0.0.1 loopback. */
  callbackUrl: string;
  /** The model to use; unset, the plan's default (the first in its catalog). */
  model?: string;
}

/** How a sign-in ended, for the app to say so. */
export type SignInResult = 'signed_in' | 'denied' | 'no_plan' | 'failed';

export interface AccountStatus {
  signed_in: boolean;
  email: string | null;
  model: string | null;
  /** The "You're using your ChatGPT plan" notice was dismissed on this host. */
  welcomed: boolean;
}

const AGENT_NAME = 'PantryMos';
/** A started sign-in that hasn't called back by then is dropped. */
const ATTEMPT_TTL = '10 minutes';
/** Refresh this long before the access token expires (it lasts an hour). */
const REFRESH_MARGIN_MS = 60_000;

const SIGNED_OUT = 'Sign in with ChatGPT to talk to Mos.';

interface SessionRow {
  client_id: string;
  email: string | null;
  id_token: string;
  access_token: string;
  refresh_token: string;
  scopes: string[];
  expires_at: Date;
  models: PlanModel[];
}

export class ChatGPTAccount implements PlanCredentials {
  private readonly pool: Pool;
  private readonly settings: ChatGPTSettings;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;

  constructor(pool: Pool, settings: ChatGPTSettings, fetchImpl: typeof fetch = fetch, now: () => number = Date.now) {
    this.pool = pool;
    this.settings = settings;
    this.fetch = fetchImpl;
    this.now = now;
  }

  /** Records a new attempt and returns the URL to open in the browser. */
  async start(): Promise<string> {
    const { verifier, challenge } = pkce();
    const state = randomToken();
    const nonce = randomToken();
    const registration = await withTransaction(this.pool, async (tx) => {
      await tx.query(`INSERT INTO agent.chatgpt_registration (host_id) VALUES ($1) ON CONFLICT DO NOTHING`, [`urn:uuid:${randomUUID()}`]);
      await tx.query(`DELETE FROM agent.chatgpt_sign_ins WHERE created_at < now() - $1::interval`, [ATTEMPT_TTL]);
      await tx.query(`INSERT INTO agent.chatgpt_sign_ins (state, verifier, nonce, redirect_uri) VALUES ($1, $2, $3, $4)`, [
        state,
        verifier,
        nonce,
        this.settings.callbackUrl,
      ]);
      return (await tx.query<{ host_id: string; client_id: string | null }>(`SELECT host_id, client_id FROM agent.chatgpt_registration`)).rows[0]!;
    });
    return authorizeUrl(this.settings, {
      clientId: registration.client_id ?? DYNAMIC_CLIENT,
      agentName: AGENT_NAME,
      hostId: registration.host_id,
      redirectUri: this.settings.callbackUrl,
      state,
      nonce,
      challenge,
    });
  }

  /** Handles the callback's query. Throws on a fault (network, a bad ID token); the caller logs it. */
  async complete(query: Record<string, string | undefined>): Promise<SignInResult> {
    if (!query.state) return 'failed';
    // Used once: a replayed callback finds nothing.
    const attempt = (
      await this.pool.query<{ verifier: string; nonce: string; redirect_uri: string }>(
        `DELETE FROM agent.chatgpt_sign_ins WHERE state = $1 AND created_at >= now() - $2::interval RETURNING verifier, nonce, redirect_uri`,
        [query.state, ATTEMPT_TTL],
      )
    ).rows[0];
    if (!attempt) return 'failed';
    if (query.error) return query.error === 'access_denied' ? 'denied' : 'failed';
    if (!query.code) return 'failed';

    const registration = (await this.pool.query<{ client_id: string | null; subject: string | null }>(`SELECT client_id, subject FROM agent.chatgpt_registration`))
      .rows[0];
    if (!registration) return 'failed';
    let clientId = registration.client_id;
    if (clientId) {
      // A sign-in again: a callback naming another client is not ours.
      if (query.client_id && query.client_id !== clientId) return 'failed';
    } else {
      if (!query.client_id) return 'failed';
      clientId = query.client_id;
      // Saved before the exchange, so a failed exchange is retried with the same issued client.
      await this.pool.query(`UPDATE agent.chatgpt_registration SET client_id = $1`, [clientId]);
    }

    const tokens = await exchangeCode(this.settings, { clientId, code: query.code, verifier: attempt.verifier, redirectUri: attempt.redirect_uri }, this.fetch);
    const scopes = (tokens.scope ?? '').split(' ').filter(Boolean);
    if (!scopes.includes(PLAN_SCOPE)) return 'no_plan';
    if (!tokens.id_token || !tokens.refresh_token) throw new Error('Token response has no ID token or refresh token');
    const identity = await verifyIdToken(this.settings, tokens.id_token, { clientId, nonce: attempt.nonce }, this.fetch, this.now());
    if (registration.subject && registration.subject !== identity.sub) return 'failed';
    // The catalog is read once, here; without it there is no default model.
    const models = await listModels(this.settings, tokens.access_token, this.fetch).catch(() => [] as PlanModel[]);

    await withTransaction(this.pool, async (tx) => {
      await tx.query(
        `INSERT INTO agent.chatgpt_session (client_id, subject, email, id_token, access_token, refresh_token, scopes, expires_at, models)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (singleton) DO UPDATE SET client_id = $1, subject = $2, email = $3, id_token = $4, access_token = $5,
           refresh_token = $6, scopes = $7, expires_at = $8, models = $9, updated_at = now()`,
        [clientId, identity.sub, identity.email ?? null, tokens.id_token, tokens.access_token, tokens.refresh_token, scopes, this.expiry(tokens.expires_in), JSON.stringify(models)],
      );
      await tx.query(`UPDATE agent.chatgpt_registration SET subject = $1`, [identity.sub]);
    });
    return 'signed_in';
  }

  async status(): Promise<AccountStatus> {
    const { rows } = await this.pool.query<{ signed_in: boolean; email: string | null; models: PlanModel[] | null; welcomed: boolean | null }>(
      `SELECT s.singleton IS NOT NULL AS signed_in, s.email, s.models, r.welcomed
         FROM agent.chatgpt_registration r FULL JOIN agent.chatgpt_session s ON true`,
    );
    const row = rows[0];
    return {
      signed_in: row?.signed_in ?? false,
      email: row?.email ?? null,
      model: row?.signed_in ? this.modelOf(row.models ?? []) : null,
      welcomed: row?.welcomed ?? false,
    };
  }

  async markWelcomed(): Promise<void> {
    await this.pool.query(`UPDATE agent.chatgpt_registration SET welcomed = true`);
  }

  /**
   * Forgets the tokens and the issued client (the next sign-in registers again, so another account
   * can sign in), then revokes the refresh token. False: revocation was not confirmed, and the user
   * can disconnect the app in ChatGPT's settings.
   */
  async signOut(): Promise<{ revoked: boolean }> {
    const session = await withTransaction(this.pool, async (tx) => {
      const row = (await tx.query<{ client_id: string; refresh_token: string }>(`DELETE FROM agent.chatgpt_session RETURNING client_id, refresh_token`)).rows[0];
      await tx.query(`UPDATE agent.chatgpt_registration SET client_id = NULL, subject = NULL`);
      return row;
    });
    if (!session) return { revoked: true };
    return { revoked: await revoke(this.settings, { clientId: session.client_id, refreshToken: session.refresh_token }, this.fetch) };
  }

  /** PlanCredentials: a token good for at least another minute, refreshed under the session's lock. */
  async current(): Promise<{ accessToken: string; model: string | null }> {
    const row = (await this.pool.query<SessionRow>(`SELECT * FROM agent.chatgpt_session`)).rows[0];
    if (!row) throw new ModelUnavailableError('signed_out', SIGNED_OUT);
    if (this.fresh(row)) return { accessToken: row.access_token, model: this.modelOf(row.models) };

    const outcome = await withTransaction(this.pool, async (tx) => {
      const locked = (await tx.query<SessionRow>(`SELECT * FROM agent.chatgpt_session FOR UPDATE`)).rows[0];
      if (!locked) return null;
      // Another request refreshed it while this one waited for the lock.
      if (this.fresh(locked)) return locked;
      try {
        const tokens = await refreshTokens(this.settings, { clientId: locked.client_id, refreshToken: locked.refresh_token }, this.fetch);
        const scopes = tokens.scope ? tokens.scope.split(' ').filter(Boolean) : locked.scopes;
        if (!scopes.includes(PLAN_SCOPE)) {
          await tx.query(`DELETE FROM agent.chatgpt_session`);
          return null;
        }
        // The refresh token rotates: the new one replaces the old together with the access token.
        const updated: SessionRow = {
          ...locked,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token ?? locked.refresh_token,
          id_token: tokens.id_token ?? locked.id_token,
          scopes,
          expires_at: this.expiry(tokens.expires_in),
        };
        await tx.query(
          `UPDATE agent.chatgpt_session SET access_token = $1, refresh_token = $2, id_token = $3, scopes = $4, expires_at = $5, updated_at = now()`,
          [updated.access_token, updated.refresh_token, updated.id_token, updated.scopes, updated.expires_at],
        );
        return updated;
      } catch (err) {
        // A refresh token that can't be used again: sign in again (with the same issued client).
        if (err instanceof OAuthError && err.terminal) {
          await tx.query(`DELETE FROM agent.chatgpt_session`);
          return null;
        }
        // Anything else (the network, a 5xx) keeps the tokens for the next try.
        throw err;
      }
    });
    if (!outcome) throw new ModelUnavailableError('signed_out', 'The ChatGPT sign-in has ended. Sign in with ChatGPT again.');
    return { accessToken: outcome.access_token, model: this.modelOf(outcome.models) };
  }

  private fresh(row: SessionRow): boolean {
    return row.expires_at.getTime() - REFRESH_MARGIN_MS > this.now();
  }

  private expiry(expiresIn: number | undefined): Date {
    return new Date(this.now() + (expiresIn ?? 3600) * 1000);
  }

  private modelOf(models: PlanModel[]): string | null {
    return this.settings.model ?? models[0]?.slug ?? null;
  }
}
