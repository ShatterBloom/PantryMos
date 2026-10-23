import { describe, expect, it } from 'vitest';
import { BedrockModel } from '../../src/model/bedrock.ts';
import { createModel, modelName } from '../../src/model/create.ts';
import { OpenAICompatibleModel } from '../../src/model/openai.ts';

describe('createModel', () => {
  const bedrock = { provider: 'bedrock', region: 'ap-southeast-2', modelId: 'global.amazon.nova-2-lite-v1:0', maxTokens: 1024 } as const;
  const openai = { provider: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b', maxTokens: 1024, timeoutMs: 60_000 } as const;

  it('builds the client for the configured provider', () => {
    expect(createModel(bedrock)).toBeInstanceOf(BedrockModel);
    expect(createModel(openai)).toBeInstanceOf(OpenAICompatibleModel);
  });

  it('names the model for reports', () => {
    expect(modelName(bedrock)).toBe('global.amazon.nova-2-lite-v1:0');
    expect(modelName(openai)).toBe('qwen3:8b (http://127.0.0.1:11434/v1)');
  });
});
