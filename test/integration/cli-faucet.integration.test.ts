/**
 * Integration test: `sphere {topup,top-up,faucet}` — testnet faucet surface.
 *
 * Backstop for the CLI extraction: the topup / top-up / faucet aliases
 * post test tokens against the Unicity faucet HTTP endpoint
 * (`https://faucet.unicity.network/api/v1/faucet/request`). All three
 * names land in the same fall-through case in `src/legacy/legacy-cli.ts`
 * (~line 2942), and `sphere faucet` is namespace-bridged to `topup` in
 * `src/index.ts`. SDK-layer coverage doesn't exist for this — the faucet
 * client is implemented entirely inside the CLI handler (it doesn't go
 * through Sphere/SDK), so this file is the ONLY layer that pins it.
 *
 * Three layers of pins:
 *
 *   1. **Help-shape pins (offline, 3 tests)** — `payments help <alias>`
 *      for each of `topup`, `top-up`, `faucet`. All three help blocks
 *      live in HELP_TEXT (~lines 597-636). Pinning all three catches a
 *      refactor that removes one alias's doc without updating the
 *      dispatch case below.
 *
 *   2. **No-nametag dispatch pins (wallet init, no HTTP)** — All three
 *      aliases require a registered nametag before they'll hit the
 *      faucet API. A fresh wallet has no nametag → command exits 1 with
 *      "No nametag registered" stderr message BEFORE any fetch is made.
 *      Running each alias and asserting the same error proves:
 *        a. the namespace bridge (`sphere faucet` → `topup`) is wired,
 *        b. all three legacy-CLI fall-through cases land on the same
 *           handler (the case label union — if a refactor splits them,
 *           only one alias would still error this way),
 *        c. the nametag precondition fires before the faucet round-trip
 *           so a user with a broken-or-rate-limited faucet endpoint
 *           still gets a clean "wallet needs a nametag" message.
 *      No faucet HTTP call is made — wallet init talks to Nostr +
 *      aggregator only.
 *
 *   3. **Live faucet request (opt-in, E2E_RUN_FAUCET=1)** — When the
 *      env var is set, register a fresh `it_<hex>` nametag and request
 *      a small amount of unicity (UCT) from the faucet. Asserts a
 *      "✓ Received" success line. Gated because (a) the faucet has rate
 *      limits and drain protection, (b) external service flakiness
 *      shouldn't break the default test suite, (c) it consumes real
 *      testnet tokens.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  createSphereEnv,
  destroySphereEnv,
  runSphere,
  integrationSkip,
  type SphereEnv,
} from './helpers.js';

/** Opt-in gate for the live faucet round-trip — disabled by default. */
const RUN_FAUCET_E2E = process.env['E2E_RUN_FAUCET'] === '1';

/**
 * The three CLI verbs that all dispatch to the same `legacy-cli.ts`
 * case block (~line 2942: `case 'topup': case 'top-up': case 'faucet':`).
 *
 * Registration is asymmetric — `faucet` is the only one in
 * `LEGACY_NAMESPACES` (src/index.ts:32), so it's the only bare top-level
 * verb; `topup` and `top-up` are reachable only as `payments topup` /
 * `payments top-up` (commander strips the `payments` namespace and
 * forwards the rest to the legacy dispatcher). For each alias we record
 * both the alias name (for help-text lookup, which goes through a
 * different unified path) and the runnable argv (for dispatch).
 */
const FAUCET_ALIASES: ReadonlyArray<{
  /** The legacy command name, also the HELP_TEXT key. */
  readonly alias: 'topup' | 'top-up' | 'faucet';
  /** Human-readable form of `invoke` for test names — `sphere <cmd>`. */
  readonly cmd: string;
  /** Argv to invoke `sphere ...` so dispatch reaches the topup handler. */
  readonly invoke: readonly string[];
}> = [
  // `sphere faucet` — registered top-level (bridge maps to `topup` in
  // legacy argv, but the case label is reachable from any of the three
  // names via fall-through).
  { alias: 'faucet', cmd: 'faucet', invoke: ['faucet'] },
  // `sphere payments topup` — `payments` namespace strips its name and
  // forwards `topup` to legacy. The bare `sphere topup` is NOT
  // registered as a top-level command and will fail with "unknown
  // command", so we explicitly route through `payments`.
  { alias: 'topup', cmd: 'payments topup', invoke: ['payments', 'topup'] },
  // `sphere payments top-up` — same reasoning as `topup`. The
  // `top-up` HELP_TEXT entry tells users this is an alias, but the
  // dispatch path is the same fall-through case.
  { alias: 'top-up', cmd: 'payments top-up', invoke: ['payments', 'top-up'] },
];

describe('sphere-cli — faucet/topup command shape (offline)', () => {
  let env: SphereEnv;

  beforeAll(() => { env = createSphereEnv('faucet-help'); });
  afterAll(() => { destroySphereEnv(env); });

  it.each(FAUCET_ALIASES)('`sphere payments help $alias` lists documented usage', ({ alias }) => {
    const r = runSphere(env, ['payments', 'help', alias], { timeoutMs: 15_000 });
    // Help dispatch is offline — pure HELP_TEXT lookup. Non-zero exit
    // means an alias's help entry was dropped (~lines 597-636 of
    // legacy-cli.ts).
    expect(r.status).toBe(0);
    // Pin the usage line and the `[<amount> <coin>]` positional shape
    // — load-bearing for users scripting `topup 100 UCT` etc.
    expect(r.stdout).toMatch(new RegExp(`Usage:.*${alias}`));
    expect(r.stdout).toMatch(/\[<amount>\s+<coin>\]/);
    // The shared description (in `topup`) or alias note (in `top-up`
    // and `faucet`) MUST reference the faucet — that's the verb's
    // entire purpose, and the doc-string is what users grep when they
    // forget which command requests tokens.
    expect(r.stdout).toMatch(/faucet/i);
  });
});

describe.skipIf(integrationSkip)(
  'sphere-cli integration — faucet without nametag (real wallet, no HTTP)',
  () => {
    // One wallet shared across all three alias tests. The fresh wallet
    // has no nametag → every faucet alias should bail BEFORE making
    // an HTTP request. We don't tear down + re-init between aliases
    // because none of them mutate wallet state on the error path.
    let env: SphereEnv;

    beforeAll(() => {
      env = createSphereEnv('faucet-no-nametag');
      const init = runSphere(env, ['wallet', 'init', '--network', 'testnet'], { timeoutMs: 120_000 });
      if (init.status !== 0) {
        console.error('wallet init failed', { status: init.status, stdout: init.stdout, stderr: init.stderr });
        throw new Error('wallet init failed; cannot proceed with faucet error-path tests');
      }
      // Sanity: the wallet has NO nametag — confirms we're testing the
      // pre-faucet error path, not a stale-state regression.
      const myNt = runSphere(env, ['nametag', 'my'], { timeoutMs: 60_000 });
      expect(myNt.stdout).toMatch(/No nametag registered/i);
    }, 180_000);

    afterAll(() => { if (env) destroySphereEnv(env); });

    it.each(FAUCET_ALIASES)(
      '`sphere $cmd` on a wallet without nametag prints error and exits non-zero',
      ({ alias, invoke }) => {
        const r = runSphere(env, [...invoke], { timeoutMs: 60_000 });

        // Exit code is the load-bearing signal for scripts wrapping
        // `sphere faucet` to detect "must register nametag first" vs.
        // a transient faucet outage. If the precondition check is
        // moved AFTER the HTTP call, this exit-code shape changes
        // (faucet failures exit 0 in the current handler).
        expect(r.status).not.toBe(0);

        const out = `${r.stdout}\n${r.stderr}`;
        // Exact wording from legacy-cli.ts ~2950:
        //   "Error: No nametag registered. Use \"nametag <name>\" first."
        // Match on the load-bearing prefix without binding to the exact
        // "Use ..." hint — the hint may legitimately evolve to suggest
        // `sphere nametag register <name>` (new namespace) instead of
        // the legacy `nametag <name>` form.
        expect(out, `${alias} should error on missing nametag`).toMatch(
          /No nametag registered/i,
        );
      },
    );
  },
);

describe.skipIf(integrationSkip || !RUN_FAUCET_E2E)(
  'sphere-cli integration — live faucet request (E2E_RUN_FAUCET=1)',
  () => {
    // Gated separately from the default suite because:
    //   - external faucet may be rate-limited / down
    //   - request consumes real testnet tokens
    //   - the on-chain nametag mint adds ~20s to the test even when
    //     the faucet itself succeeds.
    let env: SphereEnv;
    const randomName = `it_${randomBytes(4).toString('hex')}`;

    beforeAll(() => {
      env = createSphereEnv('faucet-live');
      const init = runSphere(env, ['wallet', 'init', '--network', 'testnet'], { timeoutMs: 120_000 });
      if (init.status !== 0) {
        throw new Error(`wallet init failed:\n${init.stderr}`);
      }
      // Register a nametag — required precondition for the faucet API.
      // Reuses the same on-chain registration path pinned in
      // cli-nametag.integration.test.ts (which is the SDK-layer pin
      // for this dependency; we don't re-assert it here).
      const reg = runSphere(env, ['nametag', 'register', randomName], { timeoutMs: 180_000 });
      if (reg.status !== 0) {
        throw new Error(`nametag register failed:\n${reg.stderr}`);
      }
    }, 240_000);

    afterAll(() => { if (env) destroySphereEnv(env); });

    it('`sphere faucet 1 UCT` returns a success line for the requested coin', () => {
      // Request a small amount of UCT — the faucet's native testnet
      // token. `UCT` is mapped via `FAUCET_COIN_MAP` to the `unicity`
      // faucet name (see legacy-cli.ts ~2996), so this also pins the
      // symbol→faucet-name resolution path.
      const r = runSphere(env, ['faucet', '1', 'UCT'], { timeoutMs: 60_000 });
      if (r.status !== 0) {
        console.error('faucet request failed', { stdout: r.stdout, stderr: r.stderr });
      }
      // Note: the handler does NOT exit non-zero on faucet API failure
      // (see ~3005-3007: it logs "✗ Failed" but doesn't process.exit).
      // We assert on stdout content, not just status, so a silent
      // failure flips this red.
      expect(r.status).toBe(0);

      // Two load-bearing log lines from the specific-coin branch
      // (~lines 3000-3007):
      //   "Requesting <amount> <coin> from faucet for @<nametag>..."  (always)
      //   "✓ Received <amount> <coin>"                                 (success)
      // Match the success suffix with the unicity faucet name — the
      // ✓ glyph is non-ASCII; pin the "Received" word instead so a
      // --no-emoji refactor doesn't flip red over cosmetics.
      expect(r.stdout).toMatch(/Requesting 1 unicity from faucet/i);
      expect(r.stdout).toMatch(/Received 1 unicity/i);
    }, 120_000);
  },
);
