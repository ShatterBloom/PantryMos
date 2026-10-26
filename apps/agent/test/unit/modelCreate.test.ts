import { describe, expect, it } from 'vitest';
import { ChatGPTAccount } from '../../src/chatgpt/account.ts';
import type { Pool } from '../../src/db.ts';
import { BedrockModel } from '../../src/model/bedrock.ts';
import { createModel, modelName } from '../../src/model/create.ts';
import { OpenAICompatibleModel } from '../../src/model/openai.ts';
import { ChatGPTPlanModel } from '../../src/model/responses.ts';

describe('createModel', () => {
  const pool = {} as Pool;
  const bedrock = { provider: 'bedrock', region: 'ap-southeast-2', modelId: 'global.amazon.nova-2-lite-v1:0', maxTokens: 1024 } as const;
  const openai = { provider: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b', maxTokens: 1024, timeoutMs: 60_000 } as const;
  const chatgpt = {
    provider: 'chatgpt',
    tokenKey: 'chatgpt-token-key-for-tests-0123456789',
    callbackUrl: 'http://127.0.0.1:7400/auth/chatgpt/callback',
    authUrl: 'https://auth.openai.com',
    apiUrl: 'https://api.openai.com/v1',
    maxTokens: 1024,
    timeoutMs: 120_000,
  } as const;

  it('builds the client for the configured provider, with the sign-in for a ChatGPT plan', () => {
    expect(createModel(bedrock, pool)).toMatchObject({ model: expect.any(BedrockModel), chatgpt: null });
    expect(createModel(openai, pool)).toMatchObject({ model: expect.any(OpenAICompatibleModel), chatgpt: null });
    expect(createModel(chatgpt, pool)).toMatchObject({ model: expect.any(ChatGPTPlanModel), chatgpt: expect.any(ChatGPTAccount) });
  });

  it('names the model for reports', () => {
    expect(modelName(bedrock)).toBe('global.amazon.nova-2-lite-v1:0');
    expect(modelName(openai)).toBe('qwen3:8b (http://127.0.0.1:11434/v1)');
    expect(modelName(chatgpt)).toBe('plan default (ChatGPT plan)');
    expect(modelName({ ...chatgpt, model: 'gpt-x' })).toBe('gpt-x (ChatGPT plan)');
  });
});
