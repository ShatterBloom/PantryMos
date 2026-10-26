// Which of the configured models the agent talks to: chosen in the app, kept in the agent's database.
import type { Provider } from '../config.ts';
import type { Pool } from '../db.ts';
import { type ModelClient, type ModelRequest, type ModelResponse, ModelUnavailableError } from './types.ts';

export class ModelChoice {
  private readonly pool: Pool;
  /** The providers MODEL_PROVIDERS configures. */
  readonly providers: readonly Provider[];

  constructor(pool: Pool, providers: readonly Provider[]) {
    this.pool = pool;
    this.providers = providers;
  }

  /**
   * The chosen provider. A choice no longer configured counts as none; with only one configured
   * there is nothing to choose.
   */
  async current(): Promise<Provider | null> {
    const row = (await this.pool.query<{ provider: string }>('SELECT provider FROM agent.model_choice')).rows[0];
    const chosen = this.providers.find((p) => p === row?.provider);
    return chosen ?? (this.providers.length === 1 ? this.providers[0]! : null);
  }

  /** Returns false, and changes nothing, for a provider that isn't configured. */
  async choose(provider: Provider): Promise<boolean> {
    if (!this.providers.includes(provider)) return false;
    await this.pool.query(
      `INSERT INTO agent.model_choice (provider) VALUES ($1)
       ON CONFLICT (singleton) DO UPDATE SET provider = EXCLUDED.provider, chosen_at = now()`,
      [provider],
    );
    return true;
  }
}

/**
 * The turn loop's model: whichever is chosen when each call is made, so a switch in the app applies
 * from the next model call on. Turns keep their history in the providers' common shape, so a
 * conversation carries on across a switch.
 */
export class ChosenModel implements ModelClient {
  private readonly choice: ModelChoice;
  private readonly clients: ReadonlyMap<Provider, ModelClient>;

  constructor(choice: ModelChoice, clients: ReadonlyMap<Provider, ModelClient>) {
    this.choice = choice;
    this.clients = clients;
  }

  async converse(request: ModelRequest): Promise<ModelResponse> {
    const provider = await this.choice.current();
    const client = provider && this.clients.get(provider);
    if (!client) throw new ModelUnavailableError('not_chosen', 'Choose which model Mos uses first.');
    return client.converse(request);
  }
}
