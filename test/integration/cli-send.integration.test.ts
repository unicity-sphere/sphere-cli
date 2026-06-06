/**
 * Integration test: `sphere payments send` — UXF transfer command surface.
 *
 * Replaces the coverage previously held by sphere-sdk's
 * `tests/integration/cli/uxf-transfer.test.ts`, which asserted against the
 * in-tree `cli/index.ts` source that no longer exists. The replacement
 * pins the CLI surface end-to-end:
 *
 *   1. **Help-shape pin** — `sphere payments help send` lists `--instant`,
 *      `--conservative`, `<recipient>`, `<amount>`, `<coin>`. A future
 *      refactor that drops the mode flags or rewires the positional
 *      arguments flips this red. Replaces the `--help` grep half of the
 *      old uxf-transfer.test.ts.
 *
 *   2. **Arg-validation pin** — `sphere payments send` with missing
 *      positionals exits non-zero with the documented usage line. The
 *      legacy CLI's send case rejects empty argv before Sphere.init
 *      runs, so this is cheap and offline-safe.
 *
 *   3. **End-to-end wiring pin** — `sphere payments send <addr> 0.001
 *      UCT --instant` from an empty fresh wallet reaches the SDK's
 *      `payments.send()`, fails with an "insufficient funds" /
 *      "no tokens" diagnostic, and exits non-zero. This exercises the
 *      full path:
 *        - arg parsing (`--instant` / `--conservative` → `transferMode`)
 *        - `Sphere.init()` (aggregator trustbase, IPFS publish, Nostr connect)
 *        - `sphere.payments.send({...})` call with the right `transferMode`
 *        - error surface back to the CLI exit code + stderr message
 *
 *   4. **Funded transfer (opt-in)** — When `E2E_FUNDED_MNEMONIC` is set
 *      to a 24-word testnet mnemonic with a UCT balance, the test
 *      imports that wallet, sends 0.001 UCT to a fresh recipient
 *      wallet, and polls the recipient's balance to confirm receipt.
 *      Gated to avoid forcing every test runner to maintain a funded
 *      fixture (faucet rate limits + drain protection).
 *
 * The send command shape is `sphere payments send <recipient> <amount>
 * <coin> [--instant|--conservative] [--direct|--proxy] [--no-sync]`.
 * Defaults: `--instant`, address mode auto-detected.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createSphereEnv,
  destroySphereEnv,
  runSphere,
  integrationSkip,
  type SphereEnv,
} from './helpers.js';

/** Set to a 24-word testnet mnemonic with UCT balance to enable the funded test. */
const FUNDED_MNEMONIC = process.env['E2E_FUNDED_MNEMONIC'];

describe('sphere-cli — send command shape (offline)', () => {
  it('`sphere payments help send` lists --instant, --conservative, positionals', () => {
    // No env / network — pure help-text inspection. Use a throwaway env
    // anyway so `sphere config` lookups don't hit a real profile dir.
    const env = createSphereEnv('send-help');
    try {
      const r = runSphere(env, ['payments', 'help', 'send'], { timeoutMs: 15_000 });
      expect(r.status).toBe(0);

      // Positionals — recipient, amount, coin.
      expect(r.stdout).toMatch(/<recipient>/);
      expect(r.stdout).toMatch(/<amount>/);
      expect(r.stdout).toMatch(/<coin>/);

      // Mode flags — the load-bearing UXF wiring that the deleted
      // uxf-transfer.test.ts used to pin via source-text grep. If a
      // refactor drops either flag from the help, this test flips red.
      expect(r.stdout).toMatch(/--instant/);
      expect(r.stdout).toMatch(/--conservative/);

      // Mutual-exclusion note — the legacy CLI's "cannot use both"
      // check is what guarantees `transferMode` ends up as exactly
      // one of `'instant'` / `'conservative'` when handed to
      // `payments.send()`. Pin its documentation so a refactor that
      // drops the runtime check doesn't silently drop the doc too.
      expect(r.stdout).toMatch(/[Cc]annot use both .*--instant.*--conservative|[Cc]annot use both .*--conservative.*--instant/);
    } finally {
      destroySphereEnv(env);
    }
  });

  it('`sphere payments send` with no args prints usage and exits non-zero', () => {
    const env = createSphereEnv('send-noargs');
    try {
      const r = runSphere(env, ['payments', 'send'], { timeoutMs: 15_000 });

      // Legacy CLI's send case prints "Usage: send <recipient> ..." to
      // stderr and exits non-zero when called with no positionals. The
      // exit code is the load-bearing assertion — scripts wrapping
      // `sphere payments send` rely on it for failure detection.
      expect(r.status).not.toBe(0);
      const out = `${r.stdout}\n${r.stderr}`;
      expect(out).toMatch(/Usage:.*send.*<recipient>.*<amount>.*<coin>/);
    } finally {
      destroySphereEnv(env);
    }
  });
});

describe.skipIf(integrationSkip)('sphere-cli integration — send end-to-end (real testnet)', () => {
  let env: SphereEnv;
  let directAddress: string | null = null;

  beforeAll(() => {
    env = createSphereEnv('send-e2e');

    const init = runSphere(env, ['wallet', 'init', '--network', 'testnet'], { timeoutMs: 120_000 });
    if (init.status !== 0) {
      console.error('wallet init failed', { status: init.status, stdout: init.stdout, stderr: init.stderr });
      throw new Error('wallet init failed; cannot proceed with send tests');
    }

    // Reuse the same extraction shape as cli-dm.integration.test.ts.
    const match = init.stdout.match(/directAddress\s*:\s*(DIRECT:\/\/[0-9a-fA-F]+)/);
    if (!match) throw new Error(`directAddress not found in init output:\n${init.stdout}`);
    directAddress = match[1]!;
  }, 180_000);

  afterAll(() => { if (env) destroySphereEnv(env); });

  it('`sphere payments send` from empty wallet fails cleanly with insufficient-funds error', () => {
    expect(directAddress).toBeTruthy();

    // Send to self for simplicity — the target is irrelevant when the
    // sender has no tokens. What we're pinning is the path:
    // arg-parse → Sphere.init → payments.send → empty-inventory error
    // → non-zero CLI exit. A regression that swallows the error and
    // exits 0 would flip this red.
    const r = runSphere(
      env,
      ['payments', 'send', directAddress!, '0.001', 'UCT', '--instant'],
      { timeoutMs: 120_000 },
    );

    // Exit code is the load-bearing pin. Empty-wallet sends MUST fail
    // (not silently succeed with a no-op bundle).
    expect(r.status).not.toBe(0);

    // The diagnostic is best-effort — the SDK / CLI's exact wording
    // has evolved (no tokens, insufficient balance, nothing to send).
    // Accept any of the documented surfaces. If the wording diverges
    // again, this regex is the place to extend, not to delete.
    const combined = `${r.stdout}\n${r.stderr}`.toLowerCase();
    expect(combined).toMatch(/no tokens|no .* tokens|insufficient|not enough|balance|nothing to send|cannot send/);
  }, 180_000);

  it('`sphere payments send --conservative` is accepted and reaches the empty-inventory path', () => {
    expect(directAddress).toBeTruthy();

    // Same shape as the --instant test, but with --conservative. Proves
    // the flag is wired through to the SDK (not rejected by arg parsing).
    // We're not asserting the bundle differs — that's the SDK's
    // `tests/integration/accounting/uxf-transfer.test.ts` job. We are
    // asserting the FLAG IS ACCEPTED by the CLI and reaches the call
    // site without the "cannot use both" guard tripping.
    const r = runSphere(
      env,
      ['payments', 'send', directAddress!, '0.001', 'UCT', '--conservative'],
      { timeoutMs: 120_000 },
    );

    expect(r.status).not.toBe(0);

    const combined = `${r.stdout}\n${r.stderr}`.toLowerCase();
    // Must NOT trip the mutual-exclusion guard — that would mean we
    // accidentally regressed and the CLI thinks both flags are set.
    expect(combined).not.toMatch(/cannot use both .*--instant.*--conservative|cannot use both .*--conservative.*--instant/);
    // Must hit the same insufficient-funds surface as the --instant test.
    expect(combined).toMatch(/no tokens|no .* tokens|insufficient|not enough|balance|nothing to send|cannot send/);
  }, 180_000);

  it('`sphere payments send --instant --conservative` is rejected by mutual-exclusion guard', () => {
    expect(directAddress).toBeTruthy();

    // Defensive: even with empty inventory, the mutual-exclusion guard
    // SHOULD trip before Sphere.init, so this test is fast and
    // deterministic regardless of network state.
    const r = runSphere(
      env,
      ['payments', 'send', directAddress!, '0.001', 'UCT', '--instant', '--conservative'],
      { timeoutMs: 30_000 },
    );

    expect(r.status).not.toBe(0);
    const combined = `${r.stdout}\n${r.stderr}`.toLowerCase();
    expect(combined).toMatch(/cannot use both .*--instant.*--conservative|cannot use both .*--conservative.*--instant/);
  }, 60_000);
});

describe.skipIf(integrationSkip || !FUNDED_MNEMONIC)(
  'sphere-cli integration — funded UXF transfer (E2E_FUNDED_MNEMONIC required)',
  () => {
    let senderEnv: SphereEnv;
    let receiverEnv: SphereEnv;
    let receiverDirectAddress: string | null = null;

    beforeAll(() => {
      senderEnv = createSphereEnv('send-funded-tx');
      receiverEnv = createSphereEnv('send-funded-rx');

      // Sender: import the funded mnemonic. The CLI's `init --mnemonic
      // "..."` shape is documented in `help init`.
      const importSender = runSphere(
        senderEnv,
        ['wallet', 'init', '--network', 'testnet', '--mnemonic', FUNDED_MNEMONIC!],
        { timeoutMs: 180_000 },
      );
      if (importSender.status !== 0) {
        console.error('sender import failed', { stdout: importSender.stdout, stderr: importSender.stderr });
        throw new Error('sender wallet import failed');
      }

      // Receiver: fresh wallet.
      const initReceiver = runSphere(
        receiverEnv,
        ['wallet', 'init', '--network', 'testnet'],
        { timeoutMs: 120_000 },
      );
      if (initReceiver.status !== 0) {
        console.error('receiver init failed', { stdout: initReceiver.stdout, stderr: initReceiver.stderr });
        throw new Error('receiver wallet init failed');
      }

      const match = initReceiver.stdout.match(/directAddress\s*:\s*(DIRECT:\/\/[0-9a-fA-F]+)/);
      if (!match) throw new Error(`receiver directAddress not found in init output`);
      receiverDirectAddress = match[1]!;
    }, 360_000);

    afterAll(() => {
      if (senderEnv) destroySphereEnv(senderEnv);
      if (receiverEnv) destroySphereEnv(receiverEnv);
    });

    it('sender → receiver: 0.001 UCT --instant lands in receiver inventory', async () => {
      expect(receiverDirectAddress).toBeTruthy();

      // Drive an actual UXF send.
      const send = runSphere(
        senderEnv,
        ['payments', 'send', receiverDirectAddress!, '0.001', 'UCT', '--instant'],
        { timeoutMs: 180_000 },
      );

      if (send.status !== 0) {
        console.error('funded send failed', { stdout: send.stdout, stderr: send.stderr });
      }
      expect(send.status).toBe(0);
      expect(send.stdout).toMatch(/Transfer (successful|complete|submitted|sent)|Transfer ID:/i);

      // Poll receiver inventory for the inbound transfer. NIP-17 gift-
      // wrap delivery + aggregator finalize is eventually consistent;
      // budget 5 attempts × 5s = 25s comfortably under the 120s test
      // budget.
      const MAX_ATTEMPTS = 5;
      const POLL_INTERVAL_MS = 5_000;
      let received = false;
      let lastBalance = '';
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        const balance = runSphere(receiverEnv, ['balance'], { timeoutMs: 60_000 });
        if (balance.status === 0) {
          lastBalance = balance.stdout;
          // Any non-zero UCT balance proves the transfer arrived. The
          // exact rendering varies (table, JSON) — match the symbol
          // adjacent to a non-zero digit.
          if (/UCT[\s\S]{0,80}?[1-9]/.test(balance.stdout)) {
            received = true;
            break;
          }
        }
        if (i < MAX_ATTEMPTS - 1) {
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }
      }

      if (!received) {
        console.warn(
          `receiver did not see inbound UCT within budget — likely relay/aggregator latency. ` +
            `Last balance stdout:\n${lastBalance}`,
        );
      }
      expect(received).toBe(true);
    }, 360_000);
  },
);
