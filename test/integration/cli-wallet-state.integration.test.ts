/**
 * Integration test: `sphere payments {history,sync,receive}` +
 * `sphere verify-balance` — wallet state inspection / validation surface.
 *
 * These four commands all operate on per-address wallet state but
 * along different axes:
 *
 *   - `history`        — reads local transaction history
 *                        (per-address tx ledger)
 *   - `sync`           — pulls remote storage (IPFS / token-store)
 *                        into local state
 *   - `receive`        — finalizes incoming gift-wrapped tokens
 *                        from Nostr
 *   - `verify-balance` — validates ALL local tokens against the
 *                        aggregator (detects double-spent tokens
 *                        that escaped the normal sync path)
 *
 * SDK-layer coverage for each underlying operation exists in
 * sphere-sdk's PaymentsModule + TokenValidator tests. What this file
 * pins is the CLI plumbing — exit codes, output shape, no-network-flag
 * behaviours — that wallet-management scripts rely on.
 *
 * Two layers of pins:
 *
 *   1. **Help-shape pins (offline, 4 tests)** — `payments help <name>`
 *      for each command. HELP_TEXT keys ~lines 637-700 of legacy-cli.ts.
 *
 *   2. **Fresh-wallet lifecycle (network, 4 tests)** — on a brand-new
 *      testnet wallet with no tokens, no history, no remote state:
 *        - `history` returns "No transactions found" + exit 0
 *        - `sync` completes without error + exit 0
 *        - `receive` completes without error + exit 0
 *        - `verify-balance` reports zero valid AND zero spent tokens
 *      These pins catch refactors that break the "empty wallet" path
 *      (a common regression class — the code paths that handle 0
 *      tokens / 0 entries are easy to inadvertently rely on a
 *      non-empty precondition).
 *
 * Note on isolation: per-address isolation for tokens (and by
 * extension for history, which is keyed by per-address tx storage)
 * is already pinned comprehensively by cli-multiaddress.integration.test.ts
 * (HD-address scope) and cli-wallet-profile.integration.test.ts
 * (profile scope). This file deliberately avoids re-running those
 * proofs; it focuses on the command surfaces themselves.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createSphereEnv,
  destroySphereEnv,
  runSphere,
  integrationSkip,
  type SphereEnv,
} from './helpers.js';

/**
 * HELP_TEXT keys + the must-match regexes that pin documented
 * flag/positional behaviour. Keep in sync with legacy-cli.ts
 * HELP_TEXT entries (~lines 637-700).
 */
const STATE_HELP_PINS: ReadonlyArray<{
  readonly legacy: string;
  readonly mustMatch: RegExp[];
}> = [
  // history: [limit] [--no-sync]
  { legacy: 'history',        mustMatch: [/\[limit\]/, /--no-sync/] },
  // sync: no args, but documented as "pull from remote".
  { legacy: 'sync',           mustMatch: [/sync/i] },
  // receive: --finalize
  { legacy: 'receive',        mustMatch: [/--finalize|finalize/i] },
  // verify-balance: --remove, -v|--verbose
  { legacy: 'verify-balance', mustMatch: [/--remove/, /verbose/i] },
];

describe('sphere-cli — wallet state command shape (offline)', () => {
  let env: SphereEnv;

  beforeAll(() => { env = createSphereEnv('wallet-state-help'); });
  afterAll(() => { destroySphereEnv(env); });

  for (const { legacy, mustMatch } of STATE_HELP_PINS) {
    it(`\`sphere payments help ${legacy}\` lists documented usage`, () => {
      const r = runSphere(env, ['payments', 'help', legacy], { timeoutMs: 15_000 });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(new RegExp(`Usage:.*${legacy}`));
      for (const re of mustMatch) {
        expect(r.stdout, `${legacy} help missing ${re}`).toMatch(re);
      }
    });
  }
});

describe.skipIf(integrationSkip)(
  'sphere-cli integration — wallet state on a fresh wallet (real testnet)',
  () => {
    // One wallet shared across all four state-inspection commands.
    // None of these tests mutate token state, so the same wallet is
    // safe to reuse — though `receive` and `sync` may finalize any
    // gift-wraps that happen to arrive during the test window. We
    // don't assert on the lack of tokens, only on the empty-history
    // and zero-spent invariants, which are robust to stray faucet
    // tokens (none of these tests trigger a faucet).
    let env: SphereEnv;

    beforeAll(() => {
      env = createSphereEnv('wallet-state-live');
      const init = runSphere(env, ['wallet', 'init', '--network', 'testnet'], { timeoutMs: 120_000 });
      if (init.status !== 0) {
        console.error('wallet init failed', { status: init.status, stdout: init.stdout, stderr: init.stderr });
        throw new Error('wallet init failed; cannot proceed with wallet-state tests');
      }
    }, 180_000);

    afterAll(() => { if (env) destroySphereEnv(env); });

    it('`sphere payments history` on a fresh wallet reports no transactions', () => {
      // history with default limit (10) and full sync. Fresh wallet
      // has never sent or received, so getHistory() returns [].
      const r = runSphere(env, ['payments', 'history'], { timeoutMs: 120_000 });
      if (r.status !== 0) {
        console.error('history failed', { stdout: r.stdout, stderr: r.stderr });
      }
      expect(r.status).toBe(0);
      // Header pin — load-bearing for scrapers that parse the "(last N)"
      // suffix to know how many entries to expect.
      expect(r.stdout).toMatch(/Transaction History \(last 10\):/);
      // Exact wording from legacy-cli.ts ~line 2488.
      expect(r.stdout).toMatch(/No transactions found/);
    }, 180_000);

    it('`sphere payments sync` completes successfully on a fresh wallet', () => {
      // sync calls ensureSync(sphere, 'full') and exits. No specific
      // output line — we pin exit code 0 (the load-bearing signal for
      // scripts that chain `sync && send ...`). A regression that
      // throws inside the sync path would flip the exit code red.
      const r = runSphere(env, ['payments', 'sync'], { timeoutMs: 120_000 });
      if (r.status !== 0) {
        console.error('sync failed', { stdout: r.stdout, stderr: r.stderr });
      }
      expect(r.status).toBe(0);
    }, 180_000);

    it('`sphere payments receive` on a fresh wallet completes (no errors)', () => {
      // receive without --finalize: looks for incoming gift-wraps and
      // adds them to local state (as pending if v5). A fresh wallet
      // has nothing in-flight, so this should complete cleanly.
      const r = runSphere(env, ['payments', 'receive'], { timeoutMs: 120_000 });
      if (r.status !== 0) {
        console.error('receive failed', { stdout: r.stdout, stderr: r.stderr });
      }
      expect(r.status).toBe(0);
    }, 180_000);

    it('`sphere payments verify-balance` on a fresh wallet reports zero valid and zero spent tokens', () => {
      // Asymmetric registration (same gotcha as topup / top-up): the
      // bare `sphere verify-balance` is NOT a top-level command. It
      // is reachable ONLY through `payments verify-balance` because
      // the `payments` namespace strips its own name and forwards
      // the rest to the legacy dispatcher. Pin the working form.
      //
      // verify-balance scans all local tokens against the aggregator
      // for spent-detection. Fresh wallet has no tokens, so the
      // summary block should report zero of each. Critical: a
      // regression that mis-reads "no tokens" as "all spent" would
      // surface here.
      const r = runSphere(env, ['payments', 'verify-balance'], { timeoutMs: 120_000 });
      if (r.status !== 0) {
        console.error('verify-balance failed', { stdout: r.stdout, stderr: r.stderr });
      }
      expect(r.status).toBe(0);
      // Two load-bearing pins from the summary block (~lines 2275-2277):
      //   "Valid tokens: 0"
      //   "Spent tokens: 0"
      expect(r.stdout).toMatch(/Valid tokens:\s*0/);
      expect(r.stdout).toMatch(/Spent tokens:\s*0/);
    }, 180_000);
  },
);
