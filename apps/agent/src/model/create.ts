// The model clients for the configured providers.
import { ChatGPTAccount } from '../chatgpt/account.ts';
import type { ModelConfig, Provider } from '../config.ts';
import type { Pool } from '../db.ts';
import { BedrockModel } from './bedrock.ts';
import { OpenAICompatibleModel } from './openai.ts';
import { ChatGPTPlanModel } from './responses.ts';
import type { ModelClient } from './types.ts';

export interface CreatedModel {
  model: ModelClient;
  /** The sign-in the model runs on, for a ChatGPT plan; it keeps its tokens in the agent's schema. */
  chatgpt: ChatGPTAccount | null;
}

export function createModel(config: ModelConfig, pool: Pool): CreatedModel {
  switch (config.provider) {
    case 'openai':
      return { model: new OpenAICompatibleModel(config), chatgpt: null };
    case 'chatgpt': {
      const account = new ChatGPTAccount(pool, config);
      return { model: new ChatGPTPlanModel(config, account), chatgpt: account };
    }
    default:
      return { model: new BedrockModel(config), chatgpt: null };
  }
}

export interface CreatedModels {
  clients: Map<Provider, ModelClient>;
  /** The ChatGPT sign-in, when a ChatGPT plan is one of the models. */
  chatgpt: ChatGPTAccount | null;
}

export function createModels(configs: readonly ModelConfig[], pool: Pool): CreatedModels {
  const clients = new Map<Provider, ModelClient>();
  let chatgpt: ChatGPTAccount | null = null;
  for (const config of configs) {
    const created = createModel(config, pool);
    clients.set(config.provider, created.model);
    chatgpt ??= created.chatgpt;
  }
  return { clients, chatgpt };
}

/** The model's name as reports and logs show it. */
export function modelName(config: ModelConfig): string {
  switch (config.provider) {
    case 'openai':
      return `${config.model} (${config.baseUrl})`;
    case 'chatgpt':
      return `${config.model ?? 'plan default'} (ChatGPT plan)`;
    default:
      return config.modelId;
  }
}

/** The model's id as the app shows it next to its provider; null for a ChatGPT plan's default. */
export function modelId(config: ModelConfig): string | null {
  switch (config.provider) {
    case 'openai':
      return config.model;
    case 'chatgpt':
      return config.model ?? null;
    default:
      return config.modelId;
  }
}
