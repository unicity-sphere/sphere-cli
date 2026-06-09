/**
 * Integration test: `sphere {topup,top-up,faucet}` — local-mint surface.
 *
 * Backstop for the CLI extraction: the topup / top-up / faucet aliases
 * locally mint test tokens via `sphere.payments.mintFungibleToken()` (L3
 * aggregator commit). The legacy HTTP faucet client was removed in
 * sphere-sdk#455 — no external faucet service is touched any more.
 *
 * All three names land in the same fall-through case in
 * `src/legacy/legacy-cli.ts` (~line 3830), and `sphere faucet` is
 * namespace-bridged to `topup` in `src/index.ts`.
 *
 * Two layers of pins:
 *
 *   1. **Help-shape pins (offline, 3 tests)** — `payments help <alias>`
 *      for each of `topup`, `top-up`, `faucet`. All three help blocks
 *      live in HELP_TEXT (~lines 1149-1188). Pinning all three catches a
 *      refactor that removes one alias's doc without updating the
 *      dispatch case below.
 *
 *   2. **Live local-mint request (opt-in, E2E_RUN_FAUCET=1)** — When the
 *      env var is set, run `sphere faucet 1 UCT` on a fresh wallet (no
 *      nametag — local mint doesn't require one) and assert the
 *      "✓ Received" success line. Gated because (a) the L3 aggregator is
 *      an external dependency and (b) the test consumes time on the
 *      shared testnet aggregator.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createSphereEnv,
  destroySphereEnv,
  runSphere,
  integrationSkip,
  type SphereEnv,
} from './helpers.js';

/** Opt-in gate for the live local-mint round-trip — disabled by default. */
const RUN_FAUCET_E2E = process.env['E2E_RUN_FAUCET'] === '1';

/**
 * The three CLI verbs that all dispatch to the same `legacy-cli.ts`
 * case block (~line 3830: `case 'topup': case 'top-up': case 'faucet':`).
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
    // means an alias's help entry was dropped (~lines 1149-1188 of
    // legacy-cli.ts).
    expect(r.status).toBe(0);
    // Pin the usage line and the `[<amount> <coin>]` positional shape
    // — load-bearing for users scripting `topup 100 UCT` etc.
    expect(r.stdout).toMatch(new RegExp(`Usage:.*${alias}`));
    expect(r.stdout).toMatch(/\[<amount>\s+<coin>\]/);
    // The shared description references "mint" and the legacy "faucet"
    // alias name — together they pin the verb's purpose without
    // binding the test to a single phrasing.
    expect(r.stdout).toMatch(/mint/i);
    expect(r.stdout).toMatch(/faucet/i);
  });
});

describe.skipIf(integrationSkip || !RUN_FAUCET_E2E)(
  'sphere-cli integration — live local-mint request (E2E_RUN_FAUCET=1)',
  () => {
    // Gated separately from the default suite because:
    //   - the L3 aggregator is an external dependency
    //   - the local mint waits for an inclusion proof (~1-2s on testnet)
    //   - testnet aggregator may be rate-limited / slow at times.
    let env: SphereEnv;

    beforeAll(() => {
      env = createSphereEnv('faucet-live');
      const init = runSphere(env, ['wallet', 'init', '--network', 'testnet'], { timeoutMs: 120_000 });
      if (init.status !== 0) {
        throw new Error(`wallet init failed:\n${init.stderr}`);
      }
      // Deliberately do NOT register a nametag — local mint should
      // succeed against a nametag-less wallet (one of the load-bearing
      // changes from sphere-sdk#455 vs the legacy HTTP-faucet path).
    }, 240_000);

    afterAll(() => { if (env) destroySphereEnv(env); });

    it('`sphere faucet 1 UCT` mints UCT locally and prints success', () => {
      // Request a small amount of UCT — the wallet mints to itself via
      // PaymentsModule.mintFungibleToken (no external faucet service).
      const r = runSphere(env, ['faucet', '1', 'UCT'], { timeoutMs: 60_000 });
      if (r.status !== 0) {
        console.error('local mint failed', { stdout: r.stdout, stderr: r.stderr });
      }
      expect(r.status).toBe(0);

      // Two load-bearing log lines from the specific-coin branch
      // (legacy-cli.ts ~lines 3893-3908):
      //   "Minting <amount> <symbol> locally..."   (always)
      //   "✓ Received <amount> <symbol>"           (success)
      // Match the success suffix; pin "Received" (the ✓ glyph is
      // non-ASCII).
      expect(r.stdout).toMatch(/Minting 1 UCT locally/i);
      expect(r.stdout).toMatch(/Received 1 UCT/i);
    }, 120_000);
  },
);
