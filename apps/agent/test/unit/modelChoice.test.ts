import { describe, expect, it } from 'vitest';
import type { Pool } from '../../src/db.ts';
import { ChosenModel, ModelChoice } from '../../src/model/choice.ts';
import { ModelUnavailableError } from '../../src/model/types.ts';
import { say, ScriptedModel } from '../fixtures.ts';

/** A pool whose model_choice row is `stored`. */
const poolWith = (stored: string | null) => ({ query: async () => ({ rows: stored === null ? [] : [{ provider: stored }] }) }) as unknown as Pool;
const REQUEST = { system: '', messages: [], tools: [] };

describe('ModelChoice', () => {
  it('reads the stored choice when it is configured', async () => {
    expect(await new ModelChoice(poolWith('openai'), ['bedrock', 'openai']).current()).toBe('openai');
  });

  it('counts a choice not configured as none, unless only one is configured', async () => {
    expect(await new ModelChoice(poolWith('chatgpt'), ['bedrock', 'openai']).current()).toBeNull();
    expect(await new ModelChoice(poolWith(null), ['bedrock', 'openai']).current()).toBeNull();
    expect(await new ModelChoice(poolWith('chatgpt'), ['bedrock']).current()).toBe('bedrock');
  });

  it('refuses to choose a provider not configured, without writing', async () => {
    let writes = 0;
    const pool = { query: async () => (writes++, { rows: [] }) } as unknown as Pool;
    expect(await new ModelChoice(pool, ['bedrock']).choose('openai')).toBe(false);
    expect(writes).toBe(0);
  });
});

describe('ChosenModel', () => {
  it('sends each call to the chosen model', async () => {
    const nova = new ScriptedModel().push(say('nova'));
    const gpt = new ScriptedModel().push(say('gpt'));
    const model = new ChosenModel(new ModelChoice(poolWith('openai'), ['bedrock', 'openai']), new Map([['bedrock', nova], ['openai', gpt]]));
    expect((await model.converse(REQUEST)).content).toEqual([{ text: 'gpt' }]);
    expect(nova.requests).toHaveLength(0);
  });

  it('throws not_chosen while nothing is chosen', async () => {
    const model = new ChosenModel(new ModelChoice(poolWith(null), ['bedrock', 'openai']), new Map([['bedrock', new ScriptedModel()]]));
    const err = await model.converse(REQUEST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect((err as ModelUnavailableError).reason).toBe('not_chosen');
  });
});
