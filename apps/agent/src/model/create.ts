// The model client for the configured provider.
import { ChatGPTAccount } from '../chatgpt/account.ts';
import type { AgentConfig } from '../config.ts';
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

export function createModel(config: AgentConfig['model'], pool: Pool): CreatedModel {
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

/** The model's name as reports and logs show it. */
export function modelName(config: AgentConfig['model']): string {
  switch (config.provider) {
    case 'openai':
      return `${config.model} (${config.baseUrl})`;
    case 'chatgpt':
      return `${config.model ?? 'plan default'} (ChatGPT plan)`;
    default:
      return config.modelId;
  }
}
