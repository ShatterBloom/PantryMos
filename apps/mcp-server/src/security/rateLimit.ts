// A per-key fixed-window counter, in process memory. One mcp-server process serves the household
// (one ECS task when deployed, §13.2); several replicas would need a shared store instead.

export interface Hit {
  allowed: boolean;
  /** Seconds until the window resets; set when not allowed. */
  retryAfter: number;
}

export class FixedWindowLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(max: number, windowMs: number, now: () => number = Date.now) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
  }

  hit(key: string): Hit {
    const now = this.now();
    let window = this.windows.get(key);
    if (!window || now - window.start >= this.windowMs) {
      window = { start: now, count: 0 };
      this.windows.set(key, window);
    }
    window.count += 1;
    if (window.count <= this.max) return { allowed: true, retryAfter: 0 };
    return { allowed: false, retryAfter: Math.ceil((window.start + this.windowMs - now) / 1000) };
  }
}
