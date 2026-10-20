import { buildAgentApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createPool } from './db.ts';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const app = await buildAgentApp(config, pool);
await app.listen({ host: config.bindHost, port: config.port });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(() => pool.end())
      .finally(() => process.exit(0));
  });
}
