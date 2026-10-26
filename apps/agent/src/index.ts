import { buildAgentApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createPool } from './db.ts';
import { ChosenModel, ModelChoice } from './model/choice.ts';
import { createModels } from './model/create.ts';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const { clients, chatgpt } = createModels(config.models, pool);
const choice = new ModelChoice(pool, [...clients.keys()]);
const { app } = await buildAgentApp(config, pool, { model: new ChosenModel(choice, clients), choice, chatgpt });
await app.listen({ host: config.bindHost, port: config.port });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(() => pool.end())
      .finally(() => process.exit(0));
  });
}
