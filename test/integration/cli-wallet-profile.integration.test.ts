/**
 * Integration test: `sphere wallet {list,use,create,current,delete}` —
 * multi-profile management surface, with proof of CROSS-PROFILE isolation.
 *
 * This test pins two distinct concerns:
 *
 *   A) **CLI plumbing** — namespace bridge, sub-command parsing, help
 *      text, and arg validation for the five wallet-profile commands.
 *
 *   B) **Cross-profile isolation invariant** — each named profile must
 *      get its OWN data directory and mnemonic. A leak here is worse
 *      than the HD-address leak pinned in cli-multiaddress: profiles
 *      can hold completely different mnemonics (intended for
 *      separation between personas, organizations, or environments).
 *      If profile B's wallet init ever wrote into profile A's
 *      dataDir, the user could lose access to A entirely (or worse,
 *      sign transactions with the wrong key without realising).
 *
 *      The architectural mechanism: `wallet create <name>` creates a
 *      profile in `profiles.json` with `dataDir = ./.sphere-cli-<name>`
 *      and rewrites `config.json`'s active dataDir/tokensDir pointer.
 *      `getSphere()` reads from the current `config.dataDir`, so as
 *      long as the per-profile dir scheme is honoured and the config
 *      pointer is flipped atomically on `wallet use`, isolation holds.
 *
 *      We pin this two ways:
 *        1. Profile pointer in `wallet current` output reflects the
 *           per-profile dataDir after each create/use.
 *        2. Two independent `wallet init` calls (one per profile)
 *           produce TWO DIFFERENT directAddresses, and switching back
 *           reproduces the original — proves mnemonics are separate.
 *
 * Four layers of pins:
 *
 *   1. **Help-shape pins (offline)** — `payments help <key>` for
 *      `wallet`, `wallet list`, `wallet use`, `wallet create`,
 *      `wallet current`, `wallet delete`. Multi-word HELP_TEXT keys
 *      are passed as a single argv element (commander preserves the
 *      space-containing arg).
 *
 *   2. **Arg-validation pins (offline)** — `wallet use`, `wallet
 *      create`, `wallet delete` without `<name>` exit 1 with usage
 *      hint. `wallet create '!bogus'` rejects invalid name chars.
 *      `wallet <unknown-sub>` exits 1 with the subcommand help block.
 *
 *   3. **CRUD lifecycle (offline)** — fresh wallet shows no profiles
 *      → create alice → list shows alice → create bob (auto-switches)
 *      → use alice → current shows alice → cannot delete current
 *      profile → delete bob (now non-current) → list shows only alice.
 *
 *   4. **Cross-profile isolation (network, gated by integrationSkip)** —
 *      create alice + wallet init → capture identity_A → create bob
 *      + wallet init → capture identity_B → assert A ≠ B → use alice
 *      → current shows alice's identity, not bob's → filesystem has
 *      both `.sphere-cli-alice/wallet.json` and `.sphere-cli-bob/wallet.json`
 *      as separate files.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createSphereEnv,
  destroySphereEnv,
  expectUsageHint,
  runSphere,
  integrationSkip,
  type SphereEnv,
} from './helpers.js';

/**
 * HELP_TEXT keys for the wallet umbrella + each subcommand. Multi-word
 * keys (e.g. "wallet list") are looked up directly by passing the
 * space-containing string as a SINGLE argv element to `payments help`.
 * Keep in sync with HELP_TEXT entries ~lines 472-530 of legacy-cli.ts.
 */
const WALLET_HELP_KEYS: ReadonlyArray<{ key: string; mustMatch: RegExp[] }> = [
  { key: 'wallet',         mustMatch: [/profile/i, /<subcommand>/] },
  { key: 'wallet list',    mustMatch: [/profiles/i] },
  { key: 'wallet create',  mustMatch: [/<name>/, /--network/] },
  { key: 'wallet use',     mustMatch: [/<name>/, /[Ss]witch/] },
  { key: 'wallet current', mustMatch: [/[Cc]urrent/] },
  { key: 'wallet delete',  mustMatch: [/<name>/, /[Dd]elete/] },
];

describe('sphere-cli — wallet profile help shape (offline)', () => {
  let env: SphereEnv;

  beforeAll(() => { env = createSphereEnv('wallet-profile-help'); });
  afterAll(() => { destroySphereEnv(env); });

  for (const { key, mustMatch } of WALLET_HELP_KEYS) {
    it(`\`sphere payments help "${key}"\` lists documented usage`, () => {
      const r = runSphere(env, ['payments', 'help', key], { timeoutMs: 15_000 });
      expect(r.status).toBe(0);
      // Usage line — the key itself appears after "Usage:" in the
      // HELP_TEXT body. Wallet subcommands include the full key.
      expect(r.stdout).toMatch(new RegExp(`Usage:.*${key.replace(/\s+/g, '\\s+')}`));
      for (const re of mustMatch) {
        expect(r.stdout, `${key} help missing ${re}`).toMatch(re);
      }
    });
  }
});

describe('sphere-cli — wallet profile arg validation (offline)', () => {
  let env: SphereEnv;

  beforeAll(() => { env = createSphereEnv('wallet-profile-args'); });
  afterAll(() => { destroySphereEnv(env); });

  it.each([
    // No-name cases. legacy-cli.ts subCmd handlers (~lines 1814, 1844,
    // 1934) check `profileName` and bail before any disk write.
    // Bridge: `sphere wallet use` → legacy receives ['wallet', 'use'],
    // dispatches into the wallet case, then into subCmd='use' with
    // profileName=undefined.
    ['wallet use (no name)',    ['wallet', 'use'],    'wallet use'],
    ['wallet create (no name)', ['wallet', 'create'], 'wallet create'],
    ['wallet delete (no name)', ['wallet', 'delete'], 'wallet delete'],
  ])('`sphere %s` prints usage and exits non-zero', (_label, argv, hint) => {
    const r = runSphere(env, argv, { timeoutMs: 15_000 });
    expect(r.status).not.toBe(0);
    // Each handler prints "Usage: npm run cli -- <hint> <name>" to
    // stderr (~lines 1815, 1845, 1935). Match the hint without binding
    // to the example-suffix wording.
    expectUsageHint(`${r.stdout}\n${r.stderr}`, hint, '<name>');
  });

  it('`sphere wallet create !invalid` rejects names with disallowed characters', () => {
    // Name-charset guard at ~line 1849:
    //   if (!/^[a-zA-Z0-9_-]+$/.test(profileName)) { error... exit(1); }
    // Runs BEFORE disk writes. A regression that demotes this to a
    // post-write check would let through path-traversal-like names
    // (`../foo`, `name with spaces`) and create weird subdirectories.
    const r = runSphere(env, ['wallet', 'create', '!invalid'], { timeoutMs: 15_000 });
    expect(r.status).not.toBe(0);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).toMatch(/letters.*digits|alphanumeric/i);
  });

  it('`sphere wallet bogus-sub` reports unknown subcommand and exits non-zero', () => {
    // The default-case `Unknown wallet subcommand` block (~line 1956)
    // is the catch-all. A refactor that silently dispatches unknown
    // subcommands to some other case would flip this red.
    const r = runSphere(env, ['wallet', 'bogus-sub'], { timeoutMs: 15_000 });
    expect(r.status).not.toBe(0);
    const out = `${r.stdout}\n${r.stderr}`;
    // Canonical UX wraps the rejected subcommand in quotes:
    //   `unknown wallet subcommand: "bogus-sub"`.
    expect(out).toMatch(/unknown wallet subcommand:\s*"?bogus-sub"?/i);
  });
});

describe('sphere-cli — wallet profile CRUD lifecycle (offline)', () => {
  // Lifecycle tests are ALL local file-system mutations (profiles.json
  // + config.json). No network, no wallet load. Vitest serializes
  // tests within a describe, so state evolves: empty → alice created
  // → bob created (current) → use alice (current) → delete bob →
  // attempt to delete alice (blocked).
  let env: SphereEnv;

  beforeAll(() => { env = createSphereEnv('wallet-profile-crud'); });
  afterAll(() => { destroySphereEnv(env); });

  it('`wallet list` on a fresh profile store reports "No profiles found"', () => {
    const r = runSphere(env, ['wallet', 'list'], { timeoutMs: 15_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/No profiles found/i);
  });

  it('`wallet create alice` adds the profile, auto-switches, and shows DataDir', () => {
    const r = runSphere(env, ['wallet', 'create', 'alice'], { timeoutMs: 15_000 });
    expect(r.status).toBe(0);
    // Success line + DataDir pin — the dataDir scheme
    // `./.sphere-cli-<name>` is load-bearing for the isolation
    // invariant proven in the next describe block.
    expect(r.stdout).toMatch(/Created wallet profile:\s*alice/);
    expect(r.stdout).toMatch(/DataDir:\s*\.\/\.sphere-cli-alice/);
    // Sanity-check on the underlying file: profiles.json now exists
    // and contains alice as an entry. If a refactor demotes the
    // file-write to a no-op, this catches it before the next test
    // (which depends on alice being persisted) gets confusing.
    const profilesJson = join(env.home, '.sphere-cli', 'profiles.json');
    expect(existsSync(profilesJson), 'profiles.json should be created').toBe(true);
    const parsed = JSON.parse(readFileSync(profilesJson, 'utf8'));
    expect(parsed.profiles.find((p: { name: string }) => p.name === 'alice')).toBeTruthy();
  });

  it('`wallet create alice` a second time reports "already exists" and exits non-zero', () => {
    // Duplicate-name guard at ~line 1855. Without this, the second
    // create would silently overwrite alice's dataDir pointer and
    // potentially break a user who already initialized a wallet
    // under that profile.
    const r = runSphere(env, ['wallet', 'create', 'alice'], { timeoutMs: 15_000 });
    expect(r.status).not.toBe(0);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).toMatch(/already exists/i);
  });

  it('`wallet current` after create reports alice as the active profile', () => {
    const r = runSphere(env, ['wallet', 'current'], { timeoutMs: 15_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Profile:\s*alice/);
    expect(r.stdout).toMatch(/DataDir:\s*\.\/\.sphere-cli-alice/);
  });

  it('`wallet create bob` adds a second profile and auto-switches to it', () => {
    const r = runSphere(env, ['wallet', 'create', 'bob'], { timeoutMs: 15_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Created wallet profile:\s*bob/);

    // `wallet current` should now report bob — proves create flipped
    // the active-profile pointer.
    const current = runSphere(env, ['wallet', 'current'], { timeoutMs: 15_000 });
    expect(current.stdout).toMatch(/Profile:\s*bob/);
  });

  it('`wallet list` shows BOTH profiles with the active one marked', () => {
    const r = runSphere(env, ['wallet', 'list'], { timeoutMs: 15_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/alice/);
    expect(r.stdout).toMatch(/bob/);
    // Active marker `→ ` precedes bob (created last → currently active).
    expect(r.stdout).toMatch(/→\s+bob/);
    // alice is present but NOT preceded by →.
    expect(r.stdout).not.toMatch(/→\s+alice/);
  });

  it('`wallet use alice` switches the active profile', () => {
    const r = runSphere(env, ['wallet', 'use', 'alice'], { timeoutMs: 15_000 });
    expect(r.status).toBe(0);
    // sphere-sdk#282 Residual #2 — confirmation lives on STDERR so
    // downstream `sphere wallet use … && sphere balance > file` shell
    // pipelines don't fold the banner into the captured snapshot.
    expect(r.stderr).toMatch(/Switched to wallet profile:\s*alice/);
    expect(r.stdout).not.toMatch(/Switched to wallet profile/);

    // Verify by re-reading current.
    const current = runSphere(env, ['wallet', 'current'], { timeoutMs: 15_000 });
    expect(current.stdout).toMatch(/Profile:\s*alice/);
  });

  it('`wallet use nonexistent` reports "not found" and exits non-zero', () => {
    const r = runSphere(env, ['wallet', 'use', 'nonexistent'], { timeoutMs: 15_000 });
    expect(r.status).not.toBe(0);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).toMatch(/not found/i);
  });

  it('`wallet delete alice` is REFUSED when alice is the current profile', () => {
    // Safety guard at ~line 1940: cannot delete the active profile,
    // because then `getSphere()` calls would point at a dataDir of
    // a non-existent profile. Pin this so a refactor that drops the
    // check doesn't silently let the user orphan their config.
    const r = runSphere(env, ['wallet', 'delete', 'alice'], { timeoutMs: 15_000 });
    expect(r.status).not.toBe(0);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).toMatch(/Cannot delete.*current/i);
  });

  it('`wallet delete bob` removes the non-current profile', () => {
    const r = runSphere(env, ['wallet', 'delete', 'bob'], { timeoutMs: 15_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Deleted profile:\s*bob/);
    // Note: the dataDir on disk is intentionally NOT deleted (~line
    // 1947 prints a hint about manual cleanup). We don't pin that —
    // it's a UX choice that may legitimately change.

    // Verify by re-listing — bob should be gone, alice remains.
    const list = runSphere(env, ['wallet', 'list'], { timeoutMs: 15_000 });
    expect(list.stdout).toMatch(/alice/);
    expect(list.stdout).not.toMatch(/bob/);
  });

  it('`wallet delete nonexistent` reports "not found" and exits non-zero', () => {
    const r = runSphere(env, ['wallet', 'delete', 'nonexistent'], { timeoutMs: 15_000 });
    expect(r.status).not.toBe(0);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).toMatch(/not found/i);
  });
});

describe.skipIf(integrationSkip)(
  'sphere-cli integration — cross-profile wallet isolation (real testnet)',
  () => {
    // The strongest isolation proof: two profiles, each with an
    // independent wallet init. The directAddresses (derived from the
    // mnemonics) MUST differ. Switching profiles MUST flip the
    // active dataDir + identity atomically.
    //
    // Cost: ~30-60s for two wallet inits + nostr identity binding.
    // This is the e2e equivalent of the on-disk isolation pin in
    // cli-multiaddress, but for profile-level (separate mnemonic)
    // isolation rather than HD-derivation (shared mnemonic) isolation.
    let env: SphereEnv;
    let directAddrAlice: string | null = null;
    let directAddrBob: string | null = null;

    beforeAll(() => { env = createSphereEnv('wallet-profile-isolation'); }, 30_000);

    afterAll(() => { if (env) destroySphereEnv(env); });

    it('init wallet in profile "alice" captures alice\'s directAddress', () => {
      const create = runSphere(env, ['wallet', 'create', 'alice'], { timeoutMs: 15_000 });
      expect(create.status).toBe(0);

      const init = runSphere(env, ['wallet', 'init', '--network', 'testnet'], { timeoutMs: 120_000 });
      if (init.status !== 0) {
        console.error('alice init failed', { stdout: init.stdout, stderr: init.stderr });
      }
      expect(init.status).toBe(0);

      // Canonical UX init emits a labelled identity block:
      //   `  directAddress : DIRECT://...`
      const match = init.stdout.match(/directAddress\s*:\s*(DIRECT:\/\/[0-9a-fA-F]+)/);
      expect(match, `directAddress not in alice init:\n${init.stdout}`).toBeTruthy();
      directAddrAlice = match![1]!;

      // Wallet file landed in the per-profile dataDir, not the
      // bare ./.sphere-cli — proves the active dataDir pointer is
      // honoured by `wallet init`.
      expect(existsSync(join(env.home, '.sphere-cli-alice', 'wallet.json'))).toBe(true);
    }, 180_000);

    it('init wallet in profile "bob" captures a DIFFERENT directAddress', () => {
      // ISOLATION INVARIANT — pin 1: `wallet create` auto-switches
      // to the new profile. So the init below runs against bob's
      // dataDir, with a freshly-generated mnemonic — not alice's.
      const create = runSphere(env, ['wallet', 'create', 'bob'], { timeoutMs: 15_000 });
      expect(create.status).toBe(0);

      const init = runSphere(env, ['wallet', 'init', '--network', 'testnet'], { timeoutMs: 120_000 });
      if (init.status !== 0) {
        console.error('bob init failed', { stdout: init.stdout, stderr: init.stderr });
      }
      expect(init.status).toBe(0);

      const match = init.stdout.match(/directAddress\s*:\s*(DIRECT:\/\/[0-9a-fA-F]+)/);
      expect(match, `directAddress not in bob init:\n${init.stdout}`).toBeTruthy();
      directAddrBob = match![1]!;

      // THE CORE ISOLATION PIN: bob's directAddress is derived from
      // bob's mnemonic, which must be distinct from alice's. If a
      // regression reuses alice's mnemonic (e.g. by reading the
      // wrong wallet.json), this flips red.
      expect(directAddrBob).not.toBe(directAddrAlice);

      // Filesystem belt-and-braces: BOTH per-profile wallet.json
      // files exist, with different paths. A regression that wrote
      // bob's wallet to alice's dataDir would either fail to create
      // bob's file or overwrite alice's — both visible here.
      expect(existsSync(join(env.home, '.sphere-cli-alice', 'wallet.json'))).toBe(true);
      expect(existsSync(join(env.home, '.sphere-cli-bob', 'wallet.json'))).toBe(true);
    }, 180_000);

    it('switching back to alice restores alice\'s identity (no cross-pollination)', () => {
      const use = runSphere(env, ['wallet', 'use', 'alice'], { timeoutMs: 60_000 });
      expect(use.status).toBe(0);

      // Re-read the active identity via `sphere status` (legacy
      // top-level alias, ~line 1700 in legacy-cli.ts). It prints
      // human-readable output:
      //   Direct Addr:   DIRECT://...
      //   L1 Address:    alpha1...
      // We match the Direct Addr line, which is the same identity
      // material as the JSON `directAddress` field captured during
      // wallet init.
      const status = runSphere(env, ['status'], { timeoutMs: 120_000 });
      if (status.status !== 0) {
        console.error('status failed', { stdout: status.stdout, stderr: status.stderr });
      }
      expect(status.status).toBe(0);
      expect(status.stdout).toMatch(/Profile:\s*alice/);
      const match = status.stdout.match(/Direct Addr:\s+(DIRECT:\/\/[0-9a-fA-F]+)/);
      expect(match, `Direct Addr not in status output:\n${status.stdout}`).toBeTruthy();
      // ISOLATION INVARIANT — pin 2: after switching back, the
      // wallet's identity matches the captured pre-switch value
      // EXACTLY. A leak would surface bob's directAddress here.
      expect(match![1]).toBe(directAddrAlice);
    }, 240_000);
  },
);
