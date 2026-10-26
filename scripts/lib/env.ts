import { existsSync } from 'node:fs';

/** Load `.env` from the repo root when present (Node 24 built-in). */
export function loadEnv(): void {
  if (existsSync('.env')) process.loadEnvFile('.env');
}

/** The household the dev seed creates; AGENT_HOUSEHOLD_ID picks another. */
export const DEMO_HOUSEHOLD_ID = '00000000-0000-4000-8000-000000000001';

/** The household the agent serves, which the seed creates and other clients' tokens join. */
export function agentHouseholdId(): string {
  return requireEnv('AGENT_HOUSEHOLD_ID', DEMO_HOUSEHOLD_ID);
}

export function requireEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

/** Same server as `url`, different database. */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}
