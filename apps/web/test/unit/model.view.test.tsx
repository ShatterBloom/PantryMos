// @vitest-environment jsdom
// Choosing the model in the page: asked first while none is chosen, the ones not set up greyed,
// switching from the header, and a choice that could not be saved.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Api, ModelStatus, Provider } from '../../src/lib/api.ts';
import { Plan } from '../../src/lib/plan.ts';
import { ModelPicker } from '../../src/ui/Model.tsx';

afterEach(cleanup);

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

const MODELS: ModelStatus['models'] = [
  { provider: 'bedrock', configured: true, model: 'global.amazon.nova-2-lite-v1:0' },
  { provider: 'openai', configured: false, model: null },
  { provider: 'chatgpt', configured: true, model: null },
];
const signedOut = { signed_in: false, email: null, model: null, welcomed: false };

async function setup(status: ModelStatus, options: { fail?: boolean } = {}) {
  const chosen: Provider[] = [];
  let current = status;
  const api = {
    model: async () => current,
    chooseModel: async (provider: Provider) => {
      if (options.fail) throw new Error('offline');
      chosen.push(provider);
      current = { ...current, current: provider };
      return current;
    },
  } as unknown as Api;
  const problems: string[] = [];
  const plan = new Plan(api, () => {});
  await plan.refresh();
  render(<ModelPicker plan={plan} onProblem={(t) => problems.push(t)} />);
  return { chosen, problems };
}

const option = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) }) as HTMLButtonElement;

describe('ModelPicker', () => {
  it('asks first while none is chosen, with no way to skip, and greys the ones not set up', async () => {
    const { chosen } = await setup({ current: null, models: MODELS, chatgpt: signedOut });
    expect(screen.getByRole('dialog', { name: 'Which model should Mos use?' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(option('Choose a model')).toBeTruthy();
    expect(option('Amazon Nova').textContent).toContain('global.amazon.nova-2-lite-v1:0 on Amazon Bedrock');
    expect(option('OpenAI-compatible API').disabled).toBe(true);
    expect(option('OpenAI-compatible API').textContent).toContain('Not set up: add openai to MODEL_PROVIDERS');
    expect(option('ChatGPT plan').textContent).toContain("Your plan's default model; sign in after choosing it");

    fireEvent.click(option('ChatGPT plan'));
    await settle();
    expect(chosen).toEqual(['chatgpt']);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(option('Model: ChatGPT plan')).toBeTruthy();
  });

  it('switches from the header, marks the chosen one, and cancels without a change', async () => {
    const { chosen } = await setup({ current: 'chatgpt', models: MODELS, chatgpt: { ...signedOut, signed_in: true, model: 'gpt-plan-1' } });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(option('Model: ChatGPT plan'));
    expect(option('ChatGPT plan').getAttribute('aria-pressed')).toBe('true');
    expect(option('ChatGPT plan').textContent).toContain('gpt-plan-1 on your plan');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(option('Model: ChatGPT plan'));
    // The chosen one again: nothing to save.
    fireEvent.click(option('ChatGPT plan'));
    await settle();
    expect(chosen).toEqual([]);
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(option('Model: ChatGPT plan'));
    fireEvent.click(option('Amazon Nova'));
    await settle();
    expect(chosen).toEqual(['bedrock']);
    expect(option('Model: Amazon Nova')).toBeTruthy();
  });

  it('says so when the choice could not be saved, and keeps asking', async () => {
    const { problems } = await setup({ current: null, models: MODELS, chatgpt: null }, { fail: true });
    fireEvent.click(option('Amazon Nova'));
    await settle();
    expect(problems).toEqual(["Couldn't reach Mos to change the model. Please try again."]);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(option('Amazon Nova').disabled).toBe(false);
  });

  it('shows nothing before the status has loaded', () => {
    const plan = new Plan({} as Api, () => {});
    const { container } = render(<ModelPicker plan={plan} onProblem={() => {}} />);
    expect(container.textContent).toBe('');
  });
});
