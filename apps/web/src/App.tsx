import { useEffect, useState } from 'react';
import { VoiceCheck } from './VoiceCheck.tsx';

interface Health {
  ok: boolean;
  db: boolean;
  mcp: { ok: boolean; tools: string[] };
  internal: boolean;
}

/** M0 shell: stack health + the V4 voice spike. The real chat UI arrives in M5. */
export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json() as Promise<Health>)
      .then(setHealth)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 640, margin: '2rem auto', padding: '0 1rem' }}>
      <h1>PantryMos</h1>
      <p>Simulated Alexa+ experience · M0 foundations</p>
      <section>
        <h2>Stack health</h2>
        {error && <p role="alert">Agent unreachable: {error}</p>}
        {health ? (
          <ul>
            <li>Agent database: {health.db ? 'ok' : 'down'}</li>
            <li>MCP server: {health.mcp.ok ? `ok (${health.mcp.tools.join(', ') || 'no tools'})` : 'down'}</li>
            <li>Internal API: {health.internal ? 'ok' : 'down'}</li>
          </ul>
        ) : (
          !error && <p>Checking…</p>
        )}
      </section>
      <VoiceCheck />
    </main>
  );
}
