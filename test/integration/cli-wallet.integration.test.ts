/**
 * Integration test: `sphere wallet init` against real public infrastructure.
 *
 * Hits:
 *   - Public aggregator at https://goggregator-test.unicity.network (trustbase fetch)
 *   - Public IPFS gateway at https://unicity-ipfs1.dyndns.org (identity publish)
 *   - Public Nostr relay at wss://nostr-relay.testnet.unicity.network (identity broadcast)
 *
 * Slow — typically 15-40 seconds per test on first run. Skip with SKIP_INTEGRATION=1.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createSphereEnv,
  destroySphereEnv,
  runSphere,
  integrationSkip,
  type SphereEnv,
} from './helpers.js';

// NOTE: preflight.integration.test.ts runs alongside this file and reports
// which public endpoints are reachable. It does not gate these tests —
// vitest evaluates skipIf at registration time before preflight's beforeAll
// runs. On infra outages, these tests fail with stderr diagnostics; grep
// for "aggregator is reachable" in the suite output to distinguish infra
// from real regressions.

describe.skipIf(integrationSkip)('sphere-cli integration — wallet init (real testnet)', () => {
  let env: SphereEnv;

  beforeAll(() => { env = createSphereEnv('wallet'); });
  afterAll(() => { destroySphereEnv(env); });

  it('`sphere wallet init --network testnet` creates a fresh wallet and emits identity JSON', () => {
    const r = runSphere(env, ['wallet', 'init', '--network', 'testnet'], { timeoutMs: 120_000 });

    // Diagnostic output on failure — integration tests are slow, so surface
    // the full stdout/stderr when something breaks rather than raw expect diff.
    if (r.status !== 0) {
      // eslint-disable-next-line no-console
      console.error('sphere wallet init failed', { status: r.status, stdout: r.stdout, stderr: r.stderr });
    }

    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Wallet initialized successfully/);
    // Identity block contains L1 address + direct DM address + chain pubkey.
    expect(r.stdout).toMatch(/l1Address/);
    expect(r.stdout).toMatch(/directAddress/);
    expect(r.stdout).toMatch(/chainPubkey/);
    // Generated L1 address format: alpha1q + bech32 body
    expect(r.stdout).toMatch(/alpha1[a-z0-9]+/);
  }, 120_000);

  it('`sphere wallet status` reports the initialized wallet state', () => {
    // Depends on the previous test having initialized the wallet in the same env.
    const r = runSphere(env, ['wallet', 'status']);
    expect(r.status).toBe(0);
    // Status output shape is flexible, but should mention the network.
    expect(r.stdout.toLowerCase()).toMatch(/testnet|network/);
  });
});
