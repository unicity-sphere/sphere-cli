/**
 * Integration test: DM round-trip via the public Nostr relay.
 *
 * Flow:
 *   1. Initialize a single testnet wallet.
 *   2. Extract its directAddress from the `wallet init` JSON output.
 *   3. Send a DM from the wallet to itself with a unique nonce.
 *   4. Poll `sphere dm inbox` until the nonce appears or we time out.
 *
 * This exercises:
 *   - Aggregator trustbase fetch  (Sphere.init)
 *   - IPFS identity publish       (createNodeProviders.tokenSync.ipfs)
 *   - Nostr relay connect + NIP-17 encrypted publish + subscription + decrypt
 *
 * Self-DM avoids coordinating two parallel wallet lifecycles and keeps the
 * test deterministic — the receiver is also the sender, so we don't depend
 * on two separate relay subscriptions staying alive simultaneously.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createSphereEnv,
  destroySphereEnv,
  runSphere,
  integrationSkip,
  type SphereEnv,
} from './helpers.js';

// NOTE: 00-preflight.integration.test.ts runs first (filename sort) and
// reports which public endpoints are reachable. It does not gate these
// tests — it's purely a diagnostic signal so operators can distinguish
// infra outages from code regressions at a glance. Infra outages surface
// with stderr diagnostics from the tests below in addition to the
// preflight failures.

describe.skipIf(integrationSkip)('sphere-cli integration — DM round-trip (real Nostr)', () => {
  let env: SphereEnv;
  let directAddress: string | null = null;
  let nonce: string | null = null;

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

  afterAll(() => { if (env) destroySphereEnv(env); });

  it('sends a self-DM via the public Nostr relay', () => {
    expect(directAddress).toBeTruthy();
    nonce = `sphere-cli-it-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
    // Legacy dm command prints "✓ Message sent to <recipient>" + "ID:" on success.
    expect(r.stdout).toMatch(/Message sent|ID:/i);
  }, 90_000);

  it('self-DM reaches the inbox (round-trip verified via nonce)', async () => {
    expect(directAddress).toBeTruthy();
    expect(nonce, 'previous test must have sent the DM before we can poll for it').toBeTruthy();

    // Poll the inbox — NIP-17 gift-wrap decryption on the receiving side
    // is eventually-consistent. Budget analysis: each `sphere dm inbox`
    // spawns a fresh CLI that re-runs Sphere.init() (trustbase fetch,
    // Nostr connect, subscribe) — empirically 1–4s per call. With
    // MAX_ATTEMPTS=10 and POLL_INTERVAL_MS=2000 the worst case is
    // ~60s (10×4s spawn + 9×2s sleep), comfortably under the 180s test
    // budget below.
    const MAX_ATTEMPTS = 10;
    const POLL_INTERVAL_MS = 2_000;

    let delivered = false;
    let lastStdout = '';
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const r = runSphere(env, ['dm', 'inbox'], { timeoutMs: 30_000 });
      if (r.status !== 0) {
        // eslint-disable-next-line no-console
        console.error('dm inbox failed', { attempt: i, status: r.status, stderr: r.stderr });
        break;
      }
      lastStdout = r.stdout;
      // Inbox renders the last message preview; our nonce is unique enough
      // that any occurrence means the gift-wrap landed and decrypted.
      if (lastStdout.includes(nonce!)) {
        delivered = true;
        break;
      }
      if (i < MAX_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    }

    // If delivery didn't land within the budget, surface stdout to help
    // triage whether this is relay latency, our own subscription, or a
    // real regression in sendDM. Prefer a skip-on-infra over a flaky fail.
    if (!delivered) {
      // eslint-disable-next-line no-console
      console.warn(
        'self-DM did not reach inbox within budget — likely relay propagation ' +
          `latency, not a regression. Nonce: ${nonce}. Last inbox stdout:\n${lastStdout}`,
      );
    }

    expect(delivered).toBe(true);
  }, 180_000);
});
