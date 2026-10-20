import { startServers } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const servers = await startServers(config);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void servers.close().finally(() => process.exit(0));
  });
}
