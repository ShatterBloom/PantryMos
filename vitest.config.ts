import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/*/test/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Integration tests share one Postgres test database.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
