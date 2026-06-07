/**
 * Integration test: `sphere market ...` — MarketModule CLI surface
 * (Nostr-broadcast P2P marketplace).
 *
 * Backstop for the CLI extraction: the market surface lost binary-level
 * coverage when the in-tree sphere-sdk CLI was deleted. SDK-level tests
 * cover the module mechanics; this file pins the CLI plumbing —
 * namespace bridge, arg parsing, exit codes, help text — between the
 * user and the module.
 *
 * Two layers of pins (this file):
 *
 *   1. **Help-shape pins (offline)** — `sphere payments help <legacy-name>`
 *      for all 5 market-* commands. Pins the documented usage line +
 *      key flags / positionals so a doc-drop or flag-rename flips this
 *      red.
 *
 *   2. **Arg-validation pins (offline)** — Commands that validate
 *      positionals / required flags BEFORE getSphere():
 *        - market-post:   <description> + --type
 *        - market-search: <query>
 *        - market-close:  <intentId>
 *      market-my / market-feed have no required args (they call
 *      getSphere() unconditionally).
 *
 * Live market lifecycle (post → search → close roundtrip against the
 * sphere market broadcast network) is intentionally NOT in this file.
 * The market protocol publishes long-form Nostr events to the
 * `wss://sphere-relay.unicity.network` relay; an e2e test would need
 * either that public relay (introduces external flakiness into the
 * default CI suite) or a Dockerized NIP-23-compatible relay (the local
 * unicity-tokens-relay used by the swap suite is a generic
 * nostr-rs-relay and is fine for those events). When a future PR adds
 * the local infra, this file can grow an e2e tier following the
 * cli-swap-e2e pattern.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createSphereEnv,
  destroySphereEnv,
  expectUsageHint,
  runSphere,
  type SphereEnv,
} from './helpers.js';

/**
 * Subcommands of `sphere market <sub>` and the legacy command name they
 * bridge to. The namespace bridge (src/index.ts:128) prefixes the
 * subcommand with `market-` and forwards to the legacy dispatcher.
 */
const MARKET_SUBCOMMANDS: ReadonlyArray<{
  /** Legacy command name (also HELP_TEXT key). */
  readonly legacy: string;
  /** Regex(es) that MUST appear in help output. */
  readonly mustMatch: RegExp[];
}> = [
  {
    legacy: 'market-post',
    mustMatch: [/<description>/, /--type/, /--category/, /--price/],
  },
  {
    legacy: 'market-search',
    mustMatch: [/<query>/, /--type/, /semantic search/i],
  },
  { legacy: 'market-my',    mustMatch: [/Usage:.*market-my/] },
  { legacy: 'market-close', mustMatch: [/<id>/] },
  { legacy: 'market-feed',  mustMatch: [/--rest/, /WebSocket/i] },
];

describe('sphere-cli — market command shape (offline)', () => {
  let env: SphereEnv;

  beforeAll(() => { env = createSphereEnv('market-help'); });
  afterAll(() => { destroySphereEnv(env); });

  for (const { legacy, mustMatch } of MARKET_SUBCOMMANDS) {
    it(`\`sphere payments help ${legacy}\` lists documented usage + key flags`, () => {
      const r = runSphere(env, ['payments', 'help', legacy], { timeoutMs: 15_000 });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(new RegExp(`Usage:.*${legacy}`));
      for (const re of mustMatch) {
        expect(r.stdout, `${legacy} help missing ${re}`).toMatch(re);
      }
    });
  }
});

describe('sphere-cli — market arg validation (offline)', () => {
  // These cases validate args BEFORE getSphere() (see
  // src/legacy/legacy-cli.ts:3478-3540). Missing positional /
  // required flag → usage hint + non-zero exit, no wallet load.
  let env: SphereEnv;

  beforeAll(() => { env = createSphereEnv('market-args'); });
  afterAll(() => { destroySphereEnv(env); });

  it.each([
    ['post',   'market-post'],
    ['search', 'market-search'],
    ['close',  'market-close'],
  ])('`sphere market %s` with no args prints usage and exits non-zero', (sub, legacyName) => {
    const r = runSphere(env, ['market', sub], { timeoutMs: 15_000 });
    expect(r.status).not.toBe(0);
    expectUsageHint(`${r.stdout}\n${r.stderr}`, legacyName);
  });

  it('`sphere market post "<desc>"` (missing --type) rejects with required-flag error', () => {
    // market-post first validates the description positional, then
    // separately requires the --type flag (see legacy-cli.ts:3486).
    // Missing --type → "--type <type> is required" + non-zero exit,
    // still BEFORE getSphere().
    const r = runSphere(
      env,
      ['market', 'post', 'sample item for sale'],
      { timeoutMs: 15_000 },
    );
    expect(r.status).not.toBe(0);
    const out = `${r.stdout}\n${r.stderr}`;
    // The error message lists the valid type values — pinning the
    // load-bearing fragment "--type" + "required" without binding to
    // the exact enum so a future addition (e.g. "auction") doesn't
    // require a test update.
    expect(out).toMatch(/--type.*required/i);
  });
});
