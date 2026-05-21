import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/__tests__/integration/**/*.integration.test.ts'],
    setupFiles: ['src/__tests__/integration/setup.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Integration tests run sequentially — shared DB state
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
