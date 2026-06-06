/**
 * Integration test: `sphere nametag ...` — nametag command surface.
 *
 * Backstop for the CLI extraction: when the in-tree sphere-sdk CLI was
 * deleted, the four nametag-related commands (register / info / my / sync)
 * lost binary-level coverage. SDK-layer coverage exists for the underlying
 * `registerNametag()` / transport binding plumbing (see sphere-sdk
 * `tests/unit/modules/NametagMinter.test.ts` and the nametag-sync test),
 * but the CLI plumbing — namespace bridge, arg parsing, help text — sat
 * uncovered post-extraction.
 *
 * Three layers of pins, same shape as `cli-invoice.integration.test.ts`:
 *
 *   1. **Help-shape pins (offline)** — `sphere payments help <legacy-name>`
 *      returns the legacy help block. We assert the documented usage line
 *      so a refactor that renames or removes a help entry flips this red
 *      before silently breaking caller-facing docs / discoverability.
 *
 *   2. **Arg-validation pins (offline)** — `nametag` and `nametag-info`
 *      validate their `<name>` positional BEFORE `getSphere()` (see
 *      `src/legacy/legacy-cli.ts` cases at ~2592 and ~2619). Running them
 *      from a fresh tmp profile with no name argument exits non-zero with
 *      a "Usage: ..." hint and no wallet load. Pinning these guards stops
 *      a refactor from reordering the wallet load above the arg check,
 *      which would force every "did I type the right command" probe into
 *      a full Sphere.init.
 *
 *      `my-nametag` and `nametag-sync` take no args, so they call
 *      `getSphere()` immediately — no offline arg-validation pin is
 *      possible for those. Their behaviour is covered by the e2e block.
 *
 *   3. **End-to-end lifecycle pin (network)** — One real testnet wallet,
 *      real Nostr relay, real aggregator. Drives:
 *        a. `my-nametag` on fresh wallet → "No nametag registered"
 *        b. `nametag info <random-non-existent>` → "not found"
 *        c. `nametag register <random-name>` → on-chain mint + Nostr publish
 *        d. `my-nametag` → returns the freshly-registered name
 *        e. `nametag info <registered>` → returns binding info
 *        f. `nametag sync` → re-publishes the binding
 *      Each registration mints a new on-chain token, so the name is
 *      randomized to avoid collisions across test runs.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  createSphereEnv,
  destroySphereEnv,
  expectUsageHint,
  runSphere,
  integrationSkip,
  type SphereEnv,
} from './helpers.js';

/**
 * Help-shape sweep table. Maps `sphere nametag <sub>` (new namespace) to
 * `legacy-cli` command name (what `payments help <name>` accepts) and
 * regexes that MUST appear in the help output. Keep in sync with the
 * `case 'nametag':` block in `src/index.ts` and the HELP_TEXT entries
 * in `src/legacy/legacy-cli.ts` (~lines 738-767).
 */
const NAMETAG_HELP_PINS: ReadonlyArray<{
  /** Legacy command name passed to `payments help <name>`. */
  readonly legacy: string;
  /** Regexes that MUST appear in help output. */
  readonly mustMatch: RegExp[];
}> = [
  { legacy: 'nametag',       mustMatch: [/<name>/, /Register/i] },
  { legacy: 'nametag-info',  mustMatch: [/<name>/, /Look up/i] },
  { legacy: 'my-nametag',    mustMatch: [/Show the nametag/i] },
  { legacy: 'nametag-sync',  mustMatch: [/Re-publish/i, /chainPubkey/] },
];

describe('sphere-cli — nametag command shape (offline)', () => {
  // One env reused across the offline block — `payments help` doesn't
  // read the wallet, so a single throwaway home is sufficient.
  let env: SphereEnv;

  beforeAll(() => { env = createSphereEnv('nametag-help'); });
  afterAll(() => { destroySphereEnv(env); });

  for (const { legacy, mustMatch } of NAMETAG_HELP_PINS) {
    it(`\`sphere payments help ${legacy}\` lists documented usage`, () => {
      const r = runSphere(env, ['payments', 'help', legacy], { timeoutMs: 15_000 });
      // Help dispatch is offline. Non-zero exit means the help block
      // for this subcommand was removed from `legacy-cli.ts`'s HELP_TEXT
      // map — almost always a rename or accidental deletion.
      expect(r.status).toBe(0);
      // Pin the usage line — load-bearing for users who script against
      // the CLI and rely on `--help` parsing.
      expect(r.stdout).toMatch(new RegExp(`Usage:.*${legacy}`));
      for (const re of mustMatch) {
        expect(r.stdout, `${legacy} help missing ${re}`).toMatch(re);
      }
    });
  }
});

describe('sphere-cli — nametag arg validation (offline)', () => {
  // These cases check `<name>` BEFORE `getSphere()` in legacy-cli.ts:
  //   nametag (~2592), nametag-info (~2619).
  // Missing positional → "Usage: ..." exit 1 with no wallet load.
  let env: SphereEnv;

  beforeAll(() => { env = createSphereEnv('nametag-args'); });
  afterAll(() => { destroySphereEnv(env); });

  it.each([
    // `sphere nametag` (no sub, no name) → bridge keeps argv as
    // ['nametag'] → legacy case detects missing name.
    ['nametag (no args)',          ['nametag'],             'nametag'],
    // `sphere nametag register` (no name) → bridge maps to ['nametag']
    // (rest is empty) → same usage path.
    ['nametag register (no name)', ['nametag', 'register'], 'nametag'],
    // `sphere nametag info` (no name) → bridge maps to ['nametag-info']
    // → legacy case detects missing name.
    ['nametag info (no name)',     ['nametag', 'info'],     'nametag-info'],
  ])('`sphere %s` prints usage and exits non-zero', (_label, argv, legacyName) => {
    const r = runSphere(env, argv, { timeoutMs: 15_000 });

    // Exit code is load-bearing — scripts wrapping `sphere nametag
    // register $name` rely on it for failure detection when $name is
    // empty.
    expect(r.status).not.toBe(0);

    // The legacy CLI prints "Usage: npm run cli -- <legacy-name>
    // <name>" to stderr. If a refactor moves the arg check below
    // getSphere(), this helper flips red (the user would instead see
    // "No wallet exists ..." or similar wallet-load output).
    expectUsageHint(`${r.stdout}\n${r.stderr}`, legacyName, '<name>');
  });
});

describe.skipIf(integrationSkip)(
  'sphere-cli integration — nametag lifecycle (real testnet)',
  () => {
    let env: SphereEnv;
    /**
     * Random name with `it_` prefix (collision-free across runs) and a
     * short hex tail (4 bytes → 8 hex chars). Stays well under any
     * sensible length limit while remaining identifiable in relay logs
     * as a test-suite artifact.
     */
    const randomName = `it_${randomBytes(4).toString('hex')}`;

    beforeAll(() => {
      env = createSphereEnv('nametag-lifecycle');
      const init = runSphere(env, ['wallet', 'init', '--network', 'testnet'], { timeoutMs: 120_000 });
      if (init.status !== 0) {
        console.error('wallet init failed', { status: init.status, stdout: init.stdout, stderr: init.stderr });
        throw new Error('wallet init failed; cannot proceed with nametag lifecycle tests');
      }
      // Sanity-check the wallet has a directAddress — confirms init
      // completed and we have an identity to bind the nametag to.
      expect(init.stdout).toMatch(/directAddress\s*:\s*DIRECT:\/\/[0-9a-fA-F]+/);
    }, 180_000);

    afterAll(() => { if (env) destroySphereEnv(env); });

    it('`sphere nametag my` on a fresh wallet reports no nametag', () => {
      const r = runSphere(env, ['nametag', 'my'], { timeoutMs: 60_000 });
      if (r.status !== 0) {
        console.error('nametag my (fresh) failed', { stdout: r.stdout, stderr: r.stderr });
      }
      expect(r.status).toBe(0);
      // Exact wording from legacy-cli.ts my-nametag case. The "Register
      // one with: ..." hint changing is fine, but the "No nametag
      // registered" line is the load-bearing scriptable signal.
      expect(r.stdout).toMatch(/No nametag registered/i);
    }, 120_000);

    it('`sphere nametag info <random>` for an unregistered name reports not found', () => {
      // Generate a fresh random name for the lookup so we never hit a
      // cached relay record from a prior test run.
      const ghost = `nope_${randomBytes(4).toString('hex')}`;
      const r = runSphere(env, ['nametag', 'info', ghost], { timeoutMs: 60_000 });
      if (r.status !== 0) {
        console.error('nametag info (ghost) failed', { stdout: r.stdout, stderr: r.stderr });
      }
      expect(r.status).toBe(0);
      // Match the "not found" path in legacy-cli.ts nametag-info case.
      expect(r.stdout).toMatch(new RegExp(`Nametag @${ghost} not found`, 'i'));
    }, 120_000);

    it(`\`sphere nametag register ${'<random>'}\` mints + publishes the binding`, () => {
      const r = runSphere(env, ['nametag', 'register', randomName], { timeoutMs: 180_000 });
      if (r.status !== 0) {
        console.error('nametag register failed', { stdout: r.stdout, stderr: r.stderr });
      }
      expect(r.status).toBe(0);
      // Two load-bearing log lines from legacy-cli.ts nametag case:
      //   "Registering nametag @<name>..."          (start)
      //   "✓ Nametag @<name> registered successfully!" (success)
      // The ✓ glyph is non-ASCII; match the unique suffix text instead
      // so a `--no-emoji` refactor or terminal-strip pipeline doesn't
      // flip this red over cosmetics.
      expect(r.stdout).toMatch(new RegExp(`Registering nametag @${randomName}`));
      expect(r.stdout).toMatch(new RegExp(`Nametag @${randomName} registered successfully`));
    }, 240_000);

    it('`sphere nametag my` after register returns the freshly-registered name', () => {
      const r = runSphere(env, ['nametag', 'my'], { timeoutMs: 60_000 });
      if (r.status !== 0) {
        console.error('nametag my (after register) failed', { stdout: r.stdout, stderr: r.stderr });
      }
      expect(r.status).toBe(0);
      // Wallet on disk should now carry the nametag in identity. New
      // process load → Sphere.init reads it from local state (no relay
      // dependency for this assertion).
      expect(r.stdout).toMatch(new RegExp(`Your nametag: @${randomName}`));
    }, 120_000);

    it('`sphere nametag info <registered>` resolves to a binding record', () => {
      const r = runSphere(env, ['nametag', 'info', randomName], { timeoutMs: 60_000 });
      if (r.status !== 0) {
        console.error('nametag info (registered) failed', { stdout: r.stdout, stderr: r.stderr });
      }
      expect(r.status).toBe(0);
      // legacy-cli prints "Nametag Info: @<name>" followed by the JSON
      // binding record. The record always carries the chainPubkey of
      // the registering identity (see CommunicationsModule / transport
      // binding format). Pin "header present + record carries pubkey
      // field" without overfitting to the exact JSON shape.
      expect(r.stdout).toMatch(new RegExp(`Nametag Info: @${randomName}`));
      expect(r.stdout).toMatch(/chainPubkey|publicKey|pubkey/i);
    }, 120_000);

    it('`sphere nametag sync` re-publishes the binding successfully', () => {
      const r = runSphere(env, ['nametag', 'sync'], { timeoutMs: 60_000 });
      if (r.status !== 0) {
        console.error('nametag sync failed', { stdout: r.stdout, stderr: r.stderr });
      }
      expect(r.status).toBe(0);
      // legacy-cli prints "Re-publishing nametag @<name> ..." then on
      // success "✓ Nametag @<name> synced successfully!". Match the
      // unique suffix to dodge emoji-strip false negatives.
      expect(r.stdout).toMatch(new RegExp(`Re-publishing nametag @${randomName}`));
      expect(r.stdout).toMatch(new RegExp(`Nametag @${randomName} synced successfully`));
    }, 120_000);
  },
);
