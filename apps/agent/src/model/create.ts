// The model client for the configured provider.
import type { AgentConfig } from '../config.ts';
import { BedrockModel } from './bedrock.ts';
import { OpenAICompatibleModel } from './openai.ts';
import type { ModelClient } from './types.ts';

export function createModel(config: AgentConfig['model']): ModelClient {
  return config.provider === 'openai' ? new OpenAICompatibleModel(config) : new BedrockModel(config);
}

/** The model's name as reports and logs show it. */
export const modelName = (config: AgentConfig['model']): string => (config.provider === 'openai' ? `${config.model} (${config.baseUrl})` : config.modelId);
