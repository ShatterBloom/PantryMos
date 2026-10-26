// @vitest-environment jsdom
// Sign in with ChatGPT in the page: the header's controls in each state, the welcome notice, and the
// line for a sign-in that just came back.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Api, ModelStatus } from '../../src/lib/api.ts';
import { Plan, signInResult } from '../../src/lib/plan.ts';
import { PlanControls, PlanWelcome } from '../../src/ui/Plan.tsx';

afterEach(cleanup);

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

/** The agent's model routes, scripted: each call recorded. */
function fakeApi(status: ModelStatus, options: { revoked?: boolean; fail?: boolean } = {}) {
  const calls: string[] = [];
  let current = status;
  const api = {
    model: async () => {
      calls.push('model');
      return current;
    },
    chatgptSignIn: async () => {
      calls.push('sign-in');
      if (options.fail) throw new Error('offline');
      return { authorize_url: 'https://auth.openai.com/api/accounts/authorize?x=1' };
    },
    chatgptSignOut: async () => {
      calls.push('sign-out');
      current = { ...current, chatgpt: { signed_in: false, email: null, model: null, welcomed: true } };
      return { revoked: options.revoked ?? true };
    },
    chatgptWelcomed: async () => {
      calls.push('welcomed');
      current = { ...current, chatgpt: { ...current.chatgpt!, welcomed: true } };
      return {};
    },
  };
  return { api: api as unknown as Api, calls };
}

const MODELS: ModelStatus['models'] = [
  { provider: 'bedrock', configured: true, model: 'nova' },
  { provider: 'chatgpt', configured: true, model: null },
];
const signedOut: ModelStatus = { current: 'chatgpt', models: MODELS, chatgpt: { signed_in: false, email: null, model: null, welcomed: false } };
const signedIn: ModelStatus = { current: 'chatgpt', models: MODELS, chatgpt: { signed_in: true, email: 'cook@example.com', model: 'gpt-plan-1', welcomed: true } };

async function setup(status: ModelStatus, options?: { revoked?: boolean; fail?: boolean }) {
  const fake = fakeApi(status, options);
  const visits: string[] = [];
  const problems: string[] = [];
  const plan = new Plan(fake.api, (url) => visits.push(url));
  await plan.refresh();
  render(
    <>
      <PlanControls plan={plan} onProblem={(t) => problems.push(t)} />
      <PlanWelcome plan={plan} />
    </>,
  );
  return { ...fake, plan, visits, problems };
}

describe('PlanControls', () => {
  it('shows nothing unless the chosen model is a ChatGPT plan', async () => {
    const { container } = render(<PlanControls plan={new Plan(fakeApi(signedOut).api, () => {})} onProblem={() => {}} />);
    expect(container.textContent).toBe('');
    const other = await setup({ current: 'bedrock', models: [MODELS[0]!], chatgpt: null });
    expect(screen.queryByRole('button')).toBeNull();
    expect(other.calls).toEqual(['model']);
    cleanup();
    // Offered but not chosen: no sign-in button and no welcome, even signed in and not yet welcomed.
    await setup({ ...signedIn, current: 'bedrock', chatgpt: { ...signedIn.chatgpt!, welcomed: false } });
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('signs in with "Continue with ChatGPT", sending the browser to ChatGPT', async () => {
    const { visits, calls } = await setup(signedOut);
    const button = screen.getByRole('button', { name: 'Continue with ChatGPT' });
    // OpenAI's logo beside the label, decorative: the name stays the label alone.
    expect(button.querySelector('img')?.getAttribute('src')).toMatch(/chatgpt-logo-white/);
    fireEvent.click(button);
    await settle();
    expect(calls).toEqual(['model', 'sign-in']);
    expect(visits).toEqual(['https://auth.openai.com/api/accounts/authorize?x=1']);
  });

  it('says so when the sign-in could not start', async () => {
    const { problems } = await setup(signedOut, { fail: true });
    fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }));
    await settle();
    expect(problems).toEqual(["Couldn't reach Mos to change the ChatGPT sign-in. Please try again."]);
    expect((screen.getByRole('button', { name: 'Continue with ChatGPT' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows "Using ChatGPT plan" with Manage usage while signed in, and signs out', async () => {
    const { calls, problems } = await setup(signedIn);
    expect(screen.getByText('Using ChatGPT plan').closest('.plan')?.getAttribute('title')).toBe('Signed in as cook@example.com');
    expect(screen.getByRole('link', { name: 'Manage usage' }).getAttribute('href')).toBe('https://chatgpt.com/settings/usage');
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await settle();
    expect(calls).toEqual(['model', 'sign-out', 'model']);
    expect(screen.getByRole('button', { name: 'Continue with ChatGPT' })).toBeTruthy();
    expect(problems).toEqual([]);
  });

  it('tells the user when ChatGPT did not confirm the sign-out', async () => {
    const { problems } = await setup(signedIn, { revoked: false });
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await settle();
    expect(problems).toEqual(["Signed out here, but ChatGPT didn't confirm it. You can disconnect PantryMos in ChatGPT's settings."]);
  });
});

describe('PlanWelcome', () => {
  it('shows the welcome once after the first sign-in, until "Got it"', async () => {
    const { calls } = await setup({ ...signedIn, chatgpt: { ...signedIn.chatgpt!, welcomed: false } });
    const dialog = screen.getByRole('dialog', { name: "You're using your ChatGPT plan" });
    expect(dialog.textContent).toContain('ChatGPT plan');
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls).toEqual(['model', 'welcomed', 'model']);
  });

  it('stays hidden when signed out or already welcomed', async () => {
    await setup(signedOut);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('signInResult', () => {
  it('turns the callback result into a line, or nothing when it worked', () => {
    expect(signInResult('')).toBeNull();
    expect(signInResult('?chatgpt=signed_in')).toBeNull();
    expect(signInResult('?chatgpt=denied')).toBe('ChatGPT sign-in was cancelled.');
    expect(signInResult('?chatgpt=no_plan')).toContain("didn't share plan usage");
    expect(signInResult('?chatgpt=failed')).toBe("ChatGPT sign-in didn't finish. Please try again.");
    expect(signInResult('?chatgpt=other')).toBe("ChatGPT sign-in didn't finish. Please try again.");
  });
});
