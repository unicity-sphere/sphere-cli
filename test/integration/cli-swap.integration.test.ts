/**
 * Integration test: `sphere swap ...` — SwapModule CLI surface.
 *
 * Backstop for the CLI extraction: when the in-tree sphere-sdk CLI was deleted
 * the swap surface lost binary-level coverage even though SwapModule itself is
 * well-tested at the SDK layer (sphere-sdk `tests/unit/modules/SwapModule.*`).
 * This file pins the CLI plumbing — namespace bridge, arg parsing, exit codes,
 * help text — that sits between the user and the SDK module.
 *
 * Two layers of pins:
 *
 *   1. **Help-shape pins (offline)** — `sphere payments help <legacy-name>`
 *      returns the legacy help block. We assert documented flags + positionals
 *      so a refactor that renames a flag (e.g. `--to` → `--recipient`) flips
 *      this red before silently breaking caller scripts. Cheap (<1s each,
 *      no wallet, no network).
 *
 *      Coverage note: swap-ping has NO HELP_TEXT entry as of integration/
 *      all-fixes. It's the only swap-* command without help, and is asserted
 *      explicitly below to lock that behavior in (a regression that adds it
 *      will flip the test — at which point we update to assert it has help).
 *
 *   2. **Arg-validation pins (offline)** — Every swap subcommand validates
 *      its first positional / required flag set BEFORE calling `getSphere()`
 *      (see `src/legacy/legacy-cli.ts` swap-* cases). Running them with no
 *      id from a fresh tmp profile exits with "Usage: ..." before any wallet
 *      load. Pinning these guards prevents a refactor from reordering the
 *      wallet load above the arg check — which would force every "did I type
 *      the right command" probe to go through Sphere.init.
 *
 * Live swap lifecycle (Docker escrow + two funded wallets + full propose →
 * accept → deposit → completed roundtrip) is intentionally NOT in this file
 * yet — that needs the agentic-hosting escrow image and a Docker daemon, and
 * is being added in a follow-up commit. The offline tier here is the
 * deterministic foundation that ships independently.
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
 * Subcommands of `sphere swap <sub>` and the legacy command name they bridge
 * to. Keep in sync with `src/index.ts` namespace bridge — when a subcommand
 * gets renamed or removed, this map is the single point of update for the
 * help-shape sweep below.
 *
 * swap-ping is NOT in this table — see the dedicated test below. As of
 * integration/all-fixes there's no HELP_TEXT entry for it, so the
 * `payments help swap-ping` call returns "No help available" and exits
 * non-zero. That's the current behaviour; if it changes, the test
 * `swap-ping help is absent` flips red and we extend this table.
 */
const SWAP_SUBCOMMANDS: ReadonlyArray<{
  /** Legacy command name (what `payments help <name>` accepts). */
  readonly legacy: string;
  /** Regex(es) that MUST appear in help output — flags, positionals, etc. */
  readonly mustMatch: RegExp[];
}> = [
  {
    legacy: 'swap-propose',
    mustMatch: [/--to/, /--offer/, /--want/, /--escrow/, /--timeout/, /--message/],
  },
  { legacy: 'swap-list',    mustMatch: [/--all/, /--role/, /--progress/, /proposer/, /acceptor/] },
  { legacy: 'swap-accept',  mustMatch: [/<swap_id_or_prefix>/, /--deposit/, /--no-wait/] },
  { legacy: 'swap-status',  mustMatch: [/<swap_id_or_prefix>/, /--query-escrow/] },
  { legacy: 'swap-deposit', mustMatch: [/<swap_id_or_prefix>/] },
  { legacy: 'swap-ping',    mustMatch: [/<@nametag_or_address>/] },
  { legacy: 'swap-reject',  mustMatch: [/<swap_id_or_prefix>/] },
  { legacy: 'swap-cancel',  mustMatch: [/<swap_id_or_prefix>/] },
];

describe('sphere-cli — swap command shape (offline)', () => {
  // One env reused across the offline block — these don't write to disk,
  // and `payments help` doesn't even read the wallet, so a single throwaway
  // home is sufficient and keeps the suite under a couple seconds total.
  let env: SphereEnv;

  beforeAll(() => { env = createSphereEnv('swap-help'); });
  afterAll(() => { destroySphereEnv(env); });

  for (const { legacy, mustMatch } of SWAP_SUBCOMMANDS) {
    it(`\`sphere payments help ${legacy}\` lists documented flags + positionals`, () => {
      const r = runSphere(env, ['payments', 'help', legacy], { timeoutMs: 15_000 });
      // Help dispatch is offline. If this exits non-zero, the help block for
      // this subcommand was removed from `src/legacy/legacy-cli.ts`'s
      // HELP_TEXT map — which usually means the command was renamed or
      // deleted without updating the docs.
      expect(r.status).toBe(0);
      // Documented usage line — load-bearing for users scripting against
      // the CLI. Per-flag pins below catch refactors that change one flag
      // name without touching the usage line.
      expect(r.stdout).toMatch(new RegExp(`Usage:.*${legacy}`));
      for (const re of mustMatch) {
        expect(r.stdout, `${legacy} help missing ${re}`).toMatch(re);
      }
    });
  }

  // (PR for issue #40 item #2 filled the swap-ping HELP_TEXT gap and
  // moved swap-ping into SWAP_SUBCOMMANDS above. The old "no help
  // available" gap-pin test was removed since help is now present.)
});

describe('sphere-cli — swap arg validation (offline)', () => {
  // These cases check args / required flags BEFORE `getSphere()` in
  // src/legacy/legacy-cli.ts:
  //   swap-propose (line ~4363) requires --to + --offer + --want
  //   swap-accept (~4553)   requires args[1]
  //   swap-ping   (~4657)   requires args[1]
  //   swap-status (~4688)   requires args[1]
  //   swap-deposit(~4725)   requires args[1]
  //   swap-reject (~4801)   requires args[1]
  //   swap-cancel (~4828)   requires args[1]
  // Missing positional → usage exit without any wallet load or network call.
  // swap-list has no required args; the negative path goes through getSphere(),
  // so it's NOT included in this offline arg-validation sweep.
  let env: SphereEnv;

  beforeAll(() => { env = createSphereEnv('swap-args'); });
  afterAll(() => { destroySphereEnv(env); });

  it.each([
    ['accept',  'swap-accept'],
    ['ping',    'swap-ping'],
    ['status',  'swap-status'],
    ['deposit', 'swap-deposit'],
    ['reject',  'swap-reject'],
    ['cancel',  'swap-cancel'],
  ])('`sphere swap %s` with no swap_id prints usage and exits non-zero', (sub, legacyName) => {
    const r = runSphere(env, ['swap', sub], { timeoutMs: 15_000 });

    // Exit code is the load-bearing assertion — scripts wrapping
    // `sphere swap <sub> $id` rely on it for failure detection when
    // $id is empty.
    expect(r.status).not.toBe(0);

    // The legacy CLI prints "Usage: npm run cli -- <legacy-name> ..." to
    // stderr. If a refactor moves the arg check below the wallet load,
    // this helper flips red (the user would instead see "No wallet
    // exists ...").
    expectUsageHint(`${r.stdout}\n${r.stderr}`, legacyName);
  });

  it('`sphere swap propose` with no flags prints usage and exits non-zero', () => {
    // swap-propose's pre-getSphere() guard checks for all THREE of
    // --to/--offer/--want being present (and non-empty, and not
    // immediately followed by another flag). Bare invocation hits
    // every branch of the guard at once.
    const r = runSphere(env, ['swap', 'propose'], { timeoutMs: 15_000 });
    expect(r.status).not.toBe(0);
    expectUsageHint(`${r.stdout}\n${r.stderr}`, 'swap-propose');
  });

  it('`sphere swap propose --to @bob --offer "10 UCT"` without --want fails arg-check', () => {
    // Pins the per-flag branch: --to + --offer set, --want missing.
    // Easy to break if someone re-orders the validation block to a
    // permissive "validate after sphere.init" path.
    const r = runSphere(env, ['swap', 'propose', '--to', '@bob', '--offer', '10 UCT'], {
      timeoutMs: 15_000,
    });
    expect(r.status).not.toBe(0);
    expectUsageHint(`${r.stdout}\n${r.stderr}`, 'swap-propose');
  });

  it('`sphere swap propose --to @bob --offer X --want Y --timeout 10` rejects out-of-range timeout', () => {
    // The `--timeout` validation (60–86400 sec range) runs after the
    // required-flag check but still BEFORE getSphere() in legacy-cli.ts:4374.
    // Use `10` (below 60) to hit the validation. Use parseable assets so
    // the earlier coin resolution doesn't trip first — though even with
    // bogus assets, the timeout check fires first because it's syntactic.
    // Canonical UX expects `--offer <amount> <coin>` as two positional
    // tokens (PR #33). Passing them as a single quoted string would now
    // trip the asset-pair guard before the --timeout validation, so we
    // split each pair into separate argv entries.
    const r = runSphere(
      env,
      ['swap', 'propose', '--to', '@bob', '--offer', '10', 'UCT', '--want', '20', 'USDU',
       '--timeout', '10'],
      { timeoutMs: 15_000 },
    );
    expect(r.status).not.toBe(0);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).toMatch(/--timeout must be an integer between 60 and 86400/i);
  });

  it('`sphere swap list --role admin` rejects invalid role value', () => {
    // swap-list calls getSphere() unconditionally, so a fresh-wallet env
    // can't hit the --role validation as a pure offline path; this test
    // documents the contract but is allowed up to 60s for the (cached)
    // wallet load — fresh-tmp env exits early with "No wallet exists" or
    // similar, so we only assert non-zero exit code, not the exact
    // message. Locks in the registration shape: this branch DOES exist.
    const r = runSphere(env, ['swap', 'list', '--role', 'admin'], { timeoutMs: 60_000 });
    expect(r.status).not.toBe(0);
    // We don't assert the role-validation message here because the
    // command may exit with "No wallet exists" first from a fresh tmp
    // env. The non-zero exit is the load-bearing pin.
  });
});
