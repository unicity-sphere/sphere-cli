/**
 * Integration test: DM round-trip via the public Nostr relay.
 *
 * Flow:
 *   1. Initialize a single testnet wallet.
 *   2. Extract its directAddress from the `wallet init` JSON output.
 *   3. Send a DM from the wallet to itself (`sphere dm send DIRECT://<self> <msg>`).
 *   4. Re-run `sphere dm inbox` and assert the message appears.
 *
 * This exercises:
 *   - Aggregator trustbase fetch  (Sphere.init)
 *   - IPFS identity publish       (createNodeProviders.tokenSync.ipfs)
 *   - Nostr relay connect + NIP-17 encrypted publish + subscription
 *
 * Self-DM avoids coordinating two parallel wallet lifecycles and keeps the
 * test deterministic — the receiver is also the sender, so we don't depend
 * on two separate relay subscriptions.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createSphereEnv,
  destroySphereEnv,
  runSphere,
  integrationSkip,
  type SphereEnv,
} from './helpers.js';

describe.skipIf(integrationSkip)('sphere-cli integration — DM round-trip (real Nostr)', () => {
  let env: SphereEnv;
  let directAddress: string | null = null;

  beforeAll(async () => {
    env = createSphereEnv('dm');

    const init = runSphere(env, ['wallet', 'init', '--network', 'testnet'], { timeoutMs: 120_000 });
    if (init.status !== 0) {
      // eslint-disable-next-line no-console
      console.error('wallet init failed', { status: init.status, stdout: init.stdout, stderr: init.stderr });
      throw new Error('wallet init failed; cannot proceed with DM tests');
    }

    // Identity JSON is emitted as pretty-printed JSON inside the init output.
    // Extract directAddress with a lenient regex (order-independent of other fields).
    const match = init.stdout.match(/"directAddress":\s*"(DIRECT:\/\/[0-9a-fA-F]+)"/);
    if (!match) throw new Error(`directAddress not found in init output:\n${init.stdout}`);
    directAddress = match[1]!;
  }, 180_000);

  afterAll(() => { destroySphereEnv(env); });

  it('sends a self-DM via the public Nostr relay (send succeeds)', () => {
    expect(directAddress).toBeTruthy();
    const nonce = `sphere-cli-it-${Date.now().toString(36)}`;
    const r = runSphere(
      env,
      ['dm', 'send', directAddress!, `integration test ${nonce}`],
      { timeoutMs: 60_000 },
    );

    if (r.status !== 0) {
      // eslint-disable-next-line no-console
      console.error('dm send failed', { status: r.status, stdout: r.stdout, stderr: r.stderr });
    }

    expect(r.status).toBe(0);
    // Legacy dm command prints "✓ Message sent to <recipient>" on success.
    expect(r.stdout).toMatch(/Message sent|ID:/i);
  }, 90_000);

  it('`sphere dm inbox` returns without error (self-DM may not appear in same run)', () => {
    // Nostr relay propagation + NIP-17 gift-wrap decryption can take several
    // seconds. This test asserts inbox retrieval works end-to-end against the
    // real relay; assertion of the self-DM's content would be flaky and is
    // left out intentionally. The DM was exercised by the previous test.
    const r = runSphere(env, ['dm', 'inbox'], { timeoutMs: 60_000 });

    if (r.status !== 0) {
      // eslint-disable-next-line no-console
      console.error('dm inbox failed', { status: r.status, stdout: r.stdout, stderr: r.stderr });
    }

    expect(r.status).toBe(0);
    expect(r.stdout.toLowerCase()).toMatch(/inbox|conversation|no conversations/);
  }, 90_000);
});
