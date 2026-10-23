// The ChatGPT plan the agent may run on (Sign in with ChatGPT): its sign-in state, kept for the page.
import type { Api, ModelStatus } from './api.ts';

/** How a sign-in ended, as the agent's callback reports it in `?chatgpt=`. */
const RESULTS: Record<string, string | null> = {
  signed_in: null,
  denied: 'ChatGPT sign-in was cancelled.',
  no_plan: "ChatGPT didn't share plan usage with PantryMos, so Mos can't use it. Sign in again and allow it.",
  failed: "ChatGPT sign-in didn't finish. Please try again.",
};

/** The line to show for a sign-in that just came back, or null (none, or it worked). */
export function signInResult(search: string): string | null {
  const result = new URLSearchParams(search).get('chatgpt');
  if (result === null) return null;
  return result in RESULTS ? RESULTS[result]! : RESULTS.failed!;
}

export class Plan {
  private status: ModelStatus | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly api: Api;
  private readonly navigate: (url: string) => void;

  constructor(api: Api, navigate: (url: string) => void) {
    this.api = api;
    this.navigate = navigate;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  current = (): ModelStatus | null => this.status;

  async refresh(): Promise<void> {
    this.set(await this.api.model());
  }

  /** Sends the browser to ChatGPT; it comes back to the agent's callback, then to the app. */
  async signIn(): Promise<void> {
    this.navigate((await this.api.chatgptSignIn()).authorize_url);
  }

  async signOut(): Promise<{ revoked: boolean }> {
    const result = await this.api.chatgptSignOut();
    await this.refresh();
    return result;
  }

  async welcomed(): Promise<void> {
    await this.api.chatgptWelcomed();
    await this.refresh();
  }

  private set(status: ModelStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener();
  }
}
