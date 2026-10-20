import { existsSync } from 'node:fs';

/** Load `.env` from the repo root when present (Node 24 built-in). */
export function loadEnv(): void {
  if (existsSync('.env')) process.loadEnvFile('.env');
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
