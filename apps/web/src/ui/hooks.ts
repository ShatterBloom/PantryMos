import { useEffect, useRef, useState } from 'react';

/**
 * Calls `load` now and every `ms` while mounted (§1.2: the view polls every 2 s); keeps the last
 * result and when it arrived.
 */
export function usePolling<T>(load: () => Promise<T>, ms: number): { data: T | null; error: boolean; at: number } {
  const [result, setResult] = useState<{ data: T | null; at: number }>({ data: null, at: 0 });
  const [error, setError] = useState(false);
  const latest = useRef(load);
  latest.current = load;

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const next = await latest.current();
        if (alive) {
          setResult({ data: next, at: Date.now() });
          setError(false);
        }
      } catch {
        if (alive) setError(true);
      }
      if (alive) timer = setTimeout(tick, ms);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [ms]);

  return { data: result.data, error, at: result.at };
}

/** Re-renders every `ms`, for countdowns. */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
