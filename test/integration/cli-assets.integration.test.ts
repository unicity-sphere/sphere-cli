/**
 * Integration test: `sphere payments {assets,asset-info}` — token
 * registry inspection surface.
 *
 * These two commands surface the global TokenRegistry, which is
 * fetched from a remote URL and cached locally (see
 * `NETWORKS[network].tokenRegistryUrl` in sphere-sdk constants.ts +
 * `TokenRegistry.configure()` flow). They are NOT per-address — the
 * registry is a network-level catalogue of all known coins / NFTs.
 *
 * SDK-layer coverage for the TokenRegistry itself
 * (caching, auto-refresh, race-safe load, waitForReady, etc.) lives
 * in sphere-sdk `tests/unit/registry/TokenRegistry.test.ts`. What
 * this file pins is the CLI layer: dispatch + output shape +
 * arg validation.
 *
 * Three layers of pins:
 *
 *   1. **Help-shape pins (offline, 2 tests)** — `payments help <name>`
 *      for `assets` and `asset-info`. HELP_TEXT keys ~lines 561-589.
 *
 *   2. **Arg-validation pin (offline, 1 test)** — `payments asset-info`
 *      with no identifier exits 1 with "Usage: ..." BEFORE getSphere()
 *      (~line 2122). `assets` accepts only optional `--type` so has
 *      no offline arg-validation pin.
 *
 *   3. **Network registry queries (4 tests)** — fresh testnet wallet
 *      drives:
 *        a. `payments assets` lists at least the canonical testnet
 *           coins (UCT) — proves remote fetch + format.
 *        b. `payments assets --type fungible` filters out NFTs.
 *        c. `payments asset-info UCT` returns the UCT entry with
 *           Symbol/Kind/Coin ID/Network fields populated.
 *        d. `payments asset-info <bogus>` exits 1 with "Asset not
 *           found" — pins the negative path of the multi-strategy
 *           lookup (symbol → name → coinId fallthrough).
 *
 * Note on namespace dispatch: `assets` and `asset-info` are NOT
 * top-level commands (not in LEGACY_NAMESPACES). They are only
 * reachable via `payments assets` / `payments asset-info` — same
 * asymmetric registration as `topup` / `verify-balance`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createSphereEnv,
  destroySphereEnv,
  expectUsageHint,
  runSphere,
  integrationSkip,
  type SphereEnv,
} from './helpers.js';

describe('sphere-cli — assets / asset-info command shape (offline)', () => {
  let env: SphereEnv;

  beforeAll(() => { env = createSphereEnv('assets-help'); });
  afterAll(() => { destroySphereEnv(env); });

  it('`sphere payments help assets` lists --type filter + documented behaviour', () => {
    const r = runSphere(env, ['payments', 'help', 'assets'], { timeoutMs: 15_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Usage:.*assets/);
    expect(r.stdout).toMatch(/--type/);
    // The filter takes "fungible" or "nft" — documented in the flag
    // description. Pin both keywords so a refactor that drops one
    // option silently flips this red.
    expect(r.stdout).toMatch(/fungible/i);
    expect(r.stdout).toMatch(/nft/i);
  });

  it('`sphere payments help asset-info` lists the multi-strategy lookup positional', () => {
    const r = runSphere(env, ['payments', 'help', 'asset-info'], { timeoutMs: 15_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Usage:.*asset-info/);
    // The positional shape `<symbol|name|coinId>` documents the
    // three lookup paths in legacy-cli.ts:2136-2138. If a refactor
    // drops one of the three (e.g. removes coinId lookup), the help
    // line is the first place users discover that — pin it here.
    expect(r.stdout).toMatch(/<symbol\|name\|coinId>/);
  });
});

describe('sphere-cli — asset-info arg validation (offline)', () => {
  let env: SphereEnv;

  beforeAll(() => { env = createSphereEnv('assets-args'); });
  afterAll(() => { destroySphereEnv(env); });

  it('`sphere payments asset-info` with no identifier prints usage and exits non-zero', () => {
    // Arg check at legacy-cli.ts ~line 2122 fires BEFORE getSphere(),
    // so no wallet load. This is the cheapest pin — keeps the
    // "did I type the right command" probe offline-fast for users.
    const r = runSphere(env, ['payments', 'asset-info'], { timeoutMs: 15_000 });
    expect(r.status).not.toBe(0);
    expectUsageHint(`${r.stdout}\n${r.stderr}`, 'asset-info', '<symbol|name|coinId>');
  });
});

describe.skipIf(integrationSkip)(
  'sphere-cli integration — assets / asset-info registry queries (real testnet)',
  () => {
    // One wallet shared — neither command mutates state; both just
    // read from the TokenRegistry singleton (populated during the
    // first getSphere() call from the remote registry URL).
    let env: SphereEnv;

    beforeAll(() => {
      env = createSphereEnv('assets-live');
      const init = runSphere(env, ['wallet', 'init', '--network', 'testnet'], { timeoutMs: 120_000 });
      if (init.status !== 0) {
        console.error('wallet init failed', { status: init.status, stdout: init.stdout, stderr: init.stderr });
        throw new Error('wallet init failed; cannot proceed with assets tests');
      }
    }, 180_000);

    afterAll(() => { if (env) destroySphereEnv(env); });

    it('`sphere payments assets` lists at least the canonical testnet coins (UCT)', () => {
      const r = runSphere(env, ['payments', 'assets'], { timeoutMs: 120_000 });
      if (r.status !== 0) {
        console.error('assets failed', { stdout: r.stdout, stderr: r.stderr });
      }
      expect(r.status).toBe(0);

      // Header row from legacy-cli.ts ~line 2092 — load-bearing for
      // column-aligned scrapers.
      expect(r.stdout).toMatch(/SYMBOL\s+NAME\s+KIND\s+DECIMALS\s+COIN ID/);
      // UCT is the canonical native testnet coin. Its presence proves
      // the remote registry fetched successfully — if a network
      // outage / cache miss returns an empty registry, this flips red.
      expect(r.stdout).toMatch(/^UCT\b/m);
    }, 180_000);

    it('`sphere payments assets --type fungible` filters out non-fungible entries', () => {
      // The filter at legacy-cli.ts ~lines 2080-2084 maps user input
      // (fungible/coin/coins) to `registry.getFungibleTokens()`. The
      // result MUST contain UCT (fungible) but MUST NOT contain any
      // entry whose KIND column reads "non-fungible".
      const r = runSphere(env, ['payments', 'assets', '--type', 'fungible'], { timeoutMs: 120_000 });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/^UCT\b/m);
      // No row should have KIND = "non-fungible" after the filter.
      // The KIND column is the third whitespace-separated field
      // (see legacy-cli.ts ~line 2106 padEnd(14)). Match it
      // anywhere in the output to detect leaks.
      expect(r.stdout).not.toMatch(/non-fungible/);
    }, 180_000);

    it('`sphere payments asset-info UCT` returns the canonical fungible asset record', () => {
      const r = runSphere(env, ['payments', 'asset-info', 'UCT'], { timeoutMs: 120_000 });
      if (r.status !== 0) {
        console.error('asset-info UCT failed', { stdout: r.stdout, stderr: r.stderr });
      }
      expect(r.status).toBe(0);
      // Four load-bearing fields from the asset-info output block
      // (~lines 2149-2155). Each anchors a different invariant:
      //   - Symbol: UCT — the lookup hit the symbol-strategy branch
      //   - Kind:   fungible — coin classification (not NFT)
      //   - Coin ID — non-empty hex (registry contract is "ids are
      //                non-empty hex strings", so pin "hex chars
      //                present" without binding to the exact value)
      //   - Network — confirms the testnet registry was loaded
      expect(r.stdout).toMatch(/Symbol:\s+UCT/);
      expect(r.stdout).toMatch(/Kind:\s+fungible/);
      expect(r.stdout).toMatch(/Coin ID:\s+[0-9a-f]{8,}/i);
      expect(r.stdout).toMatch(/Network:\s+\S+/);
    }, 180_000);

    it('`sphere payments asset-info <bogus>` reports "Asset not found" and exits non-zero', () => {
      // The negative-lookup path (~line 2140). Multi-strategy lookup
      // first tries symbol → name → coinId; failing all three falls
      // through to the error block. A regression that returns a
      // stale-cached entry or a partial match would flip this red.
      const r = runSphere(env, ['payments', 'asset-info', 'NOT_A_REAL_TOKEN_ZZZ'], { timeoutMs: 120_000 });
      expect(r.status).not.toBe(0);
      const out = `${r.stdout}\n${r.stderr}`;
      // Case-insensitive because failWithHelp lowercases its prose
      // ("asset not found: ...") — the asserted invariant is the
      // negative-lookup verdict reaching the user, not the casing.
      expect(out).toMatch(/asset not found/i);
    }, 180_000);
  },
);
