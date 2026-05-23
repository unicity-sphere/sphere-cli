/**
 * Integration test: `sphere payments l1-balance` — L1 (ALPHA blockchain) surface.
 *
 * Scope note: the L1 surface exposed by this CLI is intentionally narrow.
 * Only `l1-balance` is wired through `legacy-cli.ts` (~line 2168). There
 * is NO `l1-send`, `l1-history`, or `l1-receive` command at the binary
 * layer — those operations are still available via the SDK (see
 * `L1PaymentsModule` in sphere-sdk) but are not exposed as CLI verbs.
 * This file pins the one CLI surface that exists.
 *
 * SDK-layer coverage for L1 balance retrieval, Fulcrum WebSocket
 * connection, vesting classification, etc., lives in sphere-sdk
 * `tests/unit/l1/*.test.ts`. What this file pins is the CLI plumbing:
 * the legacy-CLI dispatch, the L1-module presence check, and the
 * human-readable output format that wallet scripts grep.
 *
 * Two layers of pins:
 *
 *   1. **Help-shape pin (offline)** — `sphere payments help l1-balance`
 *      returns the legacy help block with the usage line and the
 *      "Fulcrum" connection hint that signals to users this command
 *      will reach out to the electrum server on first call.
 *
 *   2. **End-to-end pin (network)** — Fresh testnet wallet → run
 *      `payments l1-balance` → assert the formatted output block:
 *        - "L1 (ALPHA) Balance:" header
 *        - "Confirmed: <number> ALPHA"
 *        - "Unconfirmed: <number> ALPHA"
 *      A fresh wallet has zero L1 balance, so we don't need any funding
 *      precondition — the assertion is purely on the output shape, not
 *      a non-zero value.
 *
 * Note on `payments.l1`: the L1 module is created automatically by the
 * default Sphere.init() flow (see CLAUDE.md "What's Included by Default"
 * → "L1 (ALPHA blockchain): Enabled, lazy Fulcrum connect"). So the
 * "L1 module not available" error path in legacy-cli.ts l1-balance case
 * (line ~2171) is unreachable through this CLI's normal init path. We
 * deliberately do NOT pin it; pinning unreachable error paths leads to
 * brittle tests that flip red on refactors of code nobody runs.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createSphereEnv,
  destroySphereEnv,
  runSphere,
  integrationSkip,
  type SphereEnv,
} from './helpers.js';

describe('sphere-cli — l1-balance command shape (offline)', () => {
  let env: SphereEnv;

  beforeAll(() => { env = createSphereEnv('l1-help'); });
  afterAll(() => { destroySphereEnv(env); });

  it('`sphere payments help l1-balance` lists documented usage', () => {
    const r = runSphere(env, ['payments', 'help', 'l1-balance'], { timeoutMs: 15_000 });
    // Help dispatch is fully offline — wallet not loaded, no network.
    // Non-zero exit means the HELP_TEXT entry was deleted (almost always
    // a rename or accidental drop).
    expect(r.status).toBe(0);
    // Pin the usage line — load-bearing for `--help` parsers.
    expect(r.stdout).toMatch(/Usage:.*l1-balance/);
    // Pin two pieces of documented behaviour:
    //   - "ALPHA" — names the L1 token symbol, distinguishes L1 from L3.
    //   - "Fulcrum" — signals to users the command opens a WebSocket
    //     to an electrum server on first call (load-bearing for ops /
    //     network-policy decisions).
    expect(r.stdout).toMatch(/ALPHA/);
    expect(r.stdout).toMatch(/Fulcrum/i);
  });
});

describe.skipIf(integrationSkip)(
  'sphere-cli integration — l1-balance (real testnet)',
  () => {
    let env: SphereEnv;

    beforeAll(() => {
      env = createSphereEnv('l1-balance-live');
      const init = runSphere(env, ['wallet', 'init', '--network', 'testnet'], { timeoutMs: 120_000 });
      if (init.status !== 0) {
        console.error('wallet init failed', { status: init.status, stdout: init.stdout, stderr: init.stderr });
        throw new Error('wallet init failed; cannot proceed with l1-balance test');
      }
    }, 180_000);

    afterAll(() => { if (env) destroySphereEnv(env); });

    it('`sphere payments l1-balance` returns formatted balance block on fresh wallet', () => {
      // Generous timeout — first L1 op opens a Fulcrum WebSocket and
      // performs handshake + UTXO query. Subsequent calls reuse the
      // connection, but this is the very first call in a fresh process.
      const r = runSphere(env, ['payments', 'l1-balance'], { timeoutMs: 120_000 });
      if (r.status !== 0) {
        console.error('l1-balance failed', { stdout: r.stdout, stderr: r.stderr });
      }
      expect(r.status).toBe(0);

      // Three load-bearing output pins from legacy-cli.ts l1-balance
      // case (~line 2178-2182):
      //   "L1 (ALPHA) Balance:"
      //   "Confirmed: <number> ALPHA"
      //   "Unconfirmed: <number> ALPHA"
      // A fresh wallet's balance is zero, so we don't assert any
      // numeric value — just the line structure. The numeric format
      // goes through `toHumanReadable()`, which emits e.g. "0" or
      // "0.00000000" depending on coin scale; pin the "<digit-or-dot>
      // ALPHA" shape without overfitting to a specific decimal count.
      expect(r.stdout).toMatch(/L1 \(ALPHA\) Balance:/);
      expect(r.stdout).toMatch(/Confirmed:\s+[\d.]+\s+ALPHA/);
      expect(r.stdout).toMatch(/Unconfirmed:\s+[\d.]+\s+ALPHA/);
    }, 180_000);
  },
);
