import { defineConfig } from 'vitest/config';

// Two projects:
// - unit: pure logic, no I/O, runs in parallel;
// - integration: real Postgres (one shared test database) and real HTTP listeners, runs serially.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['apps/*/test/unit/**/*.test.ts', 'packages/*/test/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['apps/*/test/integration/**/*.test.ts', 'packages/*/test/integration/**/*.test.ts'],
          globalSetup: ['test/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 20_000,
          hookTimeout: 60_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['apps/mcp-server/src/**', 'apps/agent/src/**', 'packages/*/src/**'],
      // Process entry points only wire config to startServers; covered by the compose smoke run.
      exclude: ['apps/*/src/index.ts'],
      reporter: ['text-summary', 'html', 'lcov'],
      thresholds: { lines: 85, functions: 85, statements: 85, branches: 80 },
    },
  },
});
