// The app's session cookie (IMPLEMENTATION_PLAN §11.4, S8): an HMAC-signed user id with an expiry.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'pm_session';

const sign = (secret: string, payload: string) => createHmac('sha256', secret).update(payload).digest('base64url');

/** `<user id, base64url>.<expiry, epoch seconds>.<HMAC of both>` */
export function issueSession(secret: string, userId: string, ttlSeconds: number, now = Date.now()): string {
  const payload = `${Buffer.from(userId).toString('base64url')}.${Math.floor(now / 1000) + ttlSeconds}`;
  return `${payload}.${sign(secret, payload)}`;
}

/** The signed-in user id, or null if the value is malformed, forged or expired. */
export function verifySession(secret: string, value: string | undefined, now = Date.now()): string | null {
  const parts = value?.split('.');
  if (parts?.length !== 3) return null;
  const [user, expiry, mac] = parts as [string, string, string];
  if (!safeEqual(mac, sign(secret, `${user}.${expiry}`))) return null;
  if (!/^\d+$/.test(expiry) || Number(expiry) * 1000 <= now) return null;
  return Buffer.from(user, 'base64url').toString();
}

/** One cookie's value from a Cookie header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const pair of header?.split(';') ?? []) {
    const eq = pair.indexOf('=');
    if (eq > 0 && pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return undefined;
}

export function sessionCookie(value: string, options: { maxAgeSeconds: number; secure: boolean }): string {
  return [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${options.maxAgeSeconds}`,
    ...(options.secure ? ['Secure'] : []),
  ].join('; ');
}

/** Constant-time string comparison (a passcode, a MAC). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
