import { defineConfig } from 'vitest/config';

/**
 * Integration tests against REAL public infrastructure:
 *   - Public Nostr relay:  wss://nostr-relay.testnet.unicity.network
 *   - Public aggregator:   https://goggregator-test.unicity.network
 *   - Public IPFS gateway: https://unicity-ipfs1.dyndns.org
 *
 * These tests are slow (seconds each, minutes in aggregate) and require
 * network connectivity. They are EXCLUDED from the default `vitest run`
 * (which only picks up `*.test.ts`). Run them with:
 *
 *     npx vitest run --config vitest.integration.config.ts
 *
 * or the npm alias:
 *
 *     npm run test:integration
 *
 * Each test creates a throwaway wallet in a temp dir so runs are isolated
 * and never touch real funds.
 */
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/integration/**/*.integration.test.ts'],
    // Network round-trips + wallet bootstrap can take 30s+ on first run.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Run sequentially to avoid relay rate-limits and shared-filesystem races.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
