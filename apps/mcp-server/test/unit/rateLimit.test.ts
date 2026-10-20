import { describe, expect, it } from 'vitest';
import { FixedWindowLimiter } from '../../src/security/rateLimit.ts';

describe('FixedWindowLimiter', () => {
  it('allows up to max hits per window per key, then reports the wait', () => {
    let now = 1_000_000;
    const limiter = new FixedWindowLimiter(2, 60_000, () => now);
    expect(limiter.hit('a')).toEqual({ allowed: true, retryAfter: 0 });
    expect(limiter.hit('a')).toEqual({ allowed: true, retryAfter: 0 });
    now += 15_000;
    expect(limiter.hit('a')).toEqual({ allowed: false, retryAfter: 45 });
    expect(limiter.hit('b').allowed).toBe(true); // keys are independent
  });

  it('starts a new window once the old one has passed', () => {
    let now = 0;
    const limiter = new FixedWindowLimiter(1, 60_000, () => now);
    limiter.hit('a');
    expect(limiter.hit('a').allowed).toBe(false);
    now = 60_000;
    expect(limiter.hit('a').allowed).toBe(true);
  });
});
