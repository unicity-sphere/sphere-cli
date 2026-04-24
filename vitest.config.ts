import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Integration tests against real public infrastructure live under
    // test/integration/**/*.integration.test.ts — excluded from the default
    // run because they are slow (15-40s each) and require network access.
    // Run them with `npm run test:integration`.
    exclude: ['node_modules/**', 'dist/**', 'test/integration/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      exclude: [
        'node_modules/**',
        'dist/**',
        'bin/**',
        '**/*.test.ts',
        '**/*.config.ts',
        '**/*.d.ts',
      ],
    },
  },
});
