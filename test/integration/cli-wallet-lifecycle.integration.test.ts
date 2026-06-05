/**
 * Integration test: `sphere {init, clear, config, status}` — wallet
 * lifecycle commands, with explicit pins for the destructive `clear`
 * confirmation guard and BIP-39 derivation determinism.
 *
 * This file fills the wallet-management gaps that
 * `cli-wallet.integration.test.ts` doesn't reach (it only covers
 * `wallet init` + `wallet status`):
 *
 *   - `clear`          — destructive wipe of ALL wallet data. Has a
 *                        confirmation prompt that `--yes` bypasses.
 *   - `config`         — show / mutate the CLI's persistent settings
 *                        (network, dataDir, tokensDir).
 *   - `init --mnemonic`— explicit deterministic import path (not just
 *                        the funded-gated test in cli-send).
 *
 * The most important pin is `clear`'s confirmation guard. Without it,
 * a user could run `sphere clear` by accident (e.g. tab-completion
 * mishap, scripted command misread) and lose their wallet keys
 * permanently. The guard demands the user type "yes" literally;
 * `--yes` / `-y` bypass it for scripted contexts. We pin both paths.
 *
 * Three layers of pins:
 *
 *   1. **Help-shape (offline, 4 tests)** — `payments help <name>` for
 *      `init`, `status`, `clear`, `config`. HELP_TEXT keys ~425-470.
 *
 *   2. **Config get/set (local, no network, 3 tests)** — `config`
 *      with no args shows JSON; `config set network <value>`
 *      mutates; `config set bogus value` exits 1 with "Unknown
 *      config key". No wallet load, no relay — pure file r/w.
 *
 *   3. **Init / clear / re-init round-trip (network, 3 tests)** —
 *      a. `wallet init` with SPHERE_ALLOW_MNEMONIC_NON_TTY=1 emits
 *         the 24-word mnemonic to stdout; capture it + the
 *         original directAddress.
 *      b. `clear` with stdin "no\n" prints "Aborted." and DOES NOT
 *         delete the wallet (re-check `status` still works).
 *      c. `clear --yes` removes the wallet (status now reports
 *         "No wallet found"), then `wallet init --mnemonic
 *         <captured>` re-derives the SAME directAddress — proving
 *         BIP-39 + HD-derivation determinism end-to-end.
 *
 * The mnemonic-round-trip pin is the strongest integration-level
 * proof of wallet-recovery correctness: any change to the derivation
 * pipeline (BIP-39 seed → master key → HD-path → secp256k1 →
 * directAddress) would surface here. SDK-level coverage of each step
 * exists in sphere-sdk but this is the only end-to-end CLI pin.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  createSphereEnv,
  destroySphereEnv,
  runSphere,
  integrationSkip,
  type SphereEnv,
} from './helpers.js';

const LIFECYCLE_HELP_PINS: ReadonlyArray<{
  readonly legacy: string;
  readonly mustMatch: RegExp[];
}> = [
  // init: --network, --mnemonic, --nametag
  { legacy: 'init',   mustMatch: [/--network/, /--mnemonic/, /--nametag/] },
  // status: shows current wallet info
  { legacy: 'status', mustMatch: [/[Ww]allet|status/i] },
  // clear: destructive, mentions irreversibility
  { legacy: 'clear',  mustMatch: [/[Dd]elete/, /irreversible|backed up|backup/i] },
  // config: shows or sets settings
  { legacy: 'config', mustMatch: [/set/, /network/, /dataDir/] },
];

describe('sphere-cli — wallet lifecycle command shape (offline)', () => {
  let env: SphereEnv;

  beforeAll(() => { env = createSphereEnv('lifecycle-help'); });
  afterAll(() => { destroySphereEnv(env); });

  for (const { legacy, mustMatch } of LIFECYCLE_HELP_PINS) {
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

describe('sphere-cli — config get/set (local, no network)', () => {
  // config is purely file-system mutation on `.sphere-cli/config.json`.
  // No wallet load, no relay. Tests can run unconditionally.
  let env: SphereEnv;

  beforeAll(() => { env = createSphereEnv('lifecycle-config'); });
  afterAll(() => { destroySphereEnv(env); });

  it('`sphere config` (no args) prints the current configuration as JSON', () => {
    const r = runSphere(env, ['config'], { timeoutMs: 15_000 });
    expect(r.status).toBe(0);
    // Output header + valid JSON body. The createSphereEnv helper
    // seeded testnet into config.json, so the JSON should reflect
    // that.
    expect(r.stdout).toMatch(/Current Configuration:/);
    expect(r.stdout).toMatch(/"network":\s*"testnet"/);
  });

  it('`sphere config set network dev` mutates the network setting on disk', () => {
    const r = runSphere(env, ['config', 'set', 'network', 'dev'], { timeoutMs: 15_000 });
    expect(r.status).toBe(0);
    // Confirmation log line (~line 1747).
    expect(r.stdout).toMatch(/Set network = dev/);

    // Verify the on-disk state changed (load-bearing — without this,
    // a refactor that demotes the saveConfig() call would still pass
    // the log-line assertion but silently no-op the persistence).
    const cfg = JSON.parse(readFileSync(join(env.home, '.sphere-cli', 'config.json'), 'utf8'));
    expect(cfg.network).toBe('dev');
  });

  it('`sphere config set bogus-key value` rejects unknown keys with exit 1', () => {
    // The key allowlist at ~lines 1735-1745 covers network /
    // dataDir / tokensDir only. Anything else falls through to the
    // error block. Pin both the rejection AND the helpful message
    // listing valid keys — the latter is user-facing documentation.
    const r = runSphere(env, ['config', 'set', 'bogus-key', 'value'], { timeoutMs: 15_000 });
    expect(r.status).not.toBe(0);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).toMatch(/Unknown config key:\s*bogus-key/);
    // The hint enumerates valid keys (~line 1743). If a future
    // refactor adds a new valid key without updating the error
    // hint, that's a doc bug — pin the three current keys.
    expect(out).toMatch(/network/);
    expect(out).toMatch(/dataDir/);
    expect(out).toMatch(/tokensDir/);
  });
});

describe.skipIf(integrationSkip)(
  'sphere-cli integration — init / clear / re-init round-trip (real testnet)',
  () => {
    // The deterministic-derivation pin: same mnemonic must always
    // produce the same directAddress. Plus the clear-confirmation
    // guard pin.
    let env: SphereEnv;
    let capturedMnemonic: string | null = null;
    let originalDirectAddress: string | null = null;

    beforeAll(() => {
      env = createSphereEnv('lifecycle-roundtrip');
      // Emit the mnemonic to stdout via the test-harness opt-in
      // (SPHERE_ALLOW_MNEMONIC_NON_TTY=1, documented at ~line 1675
      // of legacy-cli.ts). This is the SAFE way to capture a
      // generated mnemonic in an e2e test — process.env is
      // env-allowlisted in helpers.ts; the var is forwarded to the
      // child only inside this test's env block, not globally.
      env.env['SPHERE_ALLOW_MNEMONIC_NON_TTY'] = '1';

      const init = runSphere(env, ['wallet', 'init', '--network', 'testnet'], { timeoutMs: 120_000 });
      if (init.status !== 0) {
        console.error('initial wallet init failed', { stdout: init.stdout, stderr: init.stderr });
        throw new Error('initial wallet init failed');
      }

      // Extract the BIP-39 mnemonic. The non-TTY branch emits it
      // as a single line to stdout. BIP-39 valid lengths are 12, 15,
      // 18, 21, or 24 words — Sphere currently generates 12, but
      // older docs reference 24, so accept any valid length.
      // Anchor to a line consisting ONLY of space-separated
      // lowercase words to avoid matching multi-word phrases inside
      // log output (e.g. "Wallet initialized successfully").
      const mnemonicMatch = init.stdout.match(/^([a-z]+(?:\s+[a-z]+){11,23})$/m);
      expect(mnemonicMatch, `mnemonic not in stdout:\n${init.stdout}`).toBeTruthy();
      capturedMnemonic = mnemonicMatch![1]!;

      const addrMatch = init.stdout.match(/"directAddress":\s*"(DIRECT:\/\/[0-9a-fA-F]+)"/);
      expect(addrMatch, `directAddress not in stdout:\n${init.stdout}`).toBeTruthy();
      originalDirectAddress = addrMatch![1]!;
    }, 180_000);

    afterAll(() => { if (env) destroySphereEnv(env); });

    it('`sphere clear` with stdin "no" prints "Aborted." and KEEPS the wallet', () => {
      // The confirmation guard (~lines 1755-1764) reads stdin via
      // readline; "yes" proceeds, anything else aborts. Pipe "no\n"
      // so the prompt resolves cleanly.
      const r = runSphere(env, ['clear'], {
        timeoutMs: 60_000,
        input: 'no\n',
      });
      // Even on abort, the command exits 0 — it successfully did
      // what the user asked (cancel). Pin the "Aborted." log line
      // and the exit code separately so a refactor that flips one
      // without the other is visible.
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/Aborted/);

      // BELT-AND-BRACES: the wallet must NOT have been wiped.
      // Confirm by running `status` and asserting an identity is
      // present. A regression that proceeds despite "no" would
      // strip the identity here.
      const status = runSphere(env, ['status'], { timeoutMs: 60_000 });
      expect(status.status).toBe(0);
      expect(status.stdout).toMatch(new RegExp(`Direct Addr:\\s+${originalDirectAddress}`));
    }, 120_000);

    it('`sphere clear --yes` bypasses the guard and removes the wallet', () => {
      // --yes (or -y, ~line 1756) bypasses the interactive prompt.
      // Both flags reach the same fall-through; we pin --yes here
      // because it's the more discoverable name.
      const r = runSphere(env, ['clear', '--yes'], { timeoutMs: 60_000 });
      if (r.status !== 0) {
        console.error('clear --yes failed', { stdout: r.stdout, stderr: r.stderr });
      }
      expect(r.status).toBe(0);
      // Two log lines from the success path (~lines 1777, 1779):
      //   "Clearing all wallet data..."
      //   "All wallet data cleared."
      expect(r.stdout).toMatch(/Clearing all wallet data/);
      expect(r.stdout).toMatch(/All wallet data cleared/);

      // Verify the wallet really IS gone — `status` should now
      // report "No wallet found" (~line 1707).
      const status = runSphere(env, ['status'], { timeoutMs: 60_000 });
      expect(status.status).toBe(0);
      expect(status.stdout).toMatch(/No wallet found/i);
    }, 120_000);

    it('`wallet init --mnemonic <captured>` re-derives the SAME directAddress (BIP-39 determinism)', () => {
      expect(capturedMnemonic, 'mnemonic must be captured by beforeAll').toBeTruthy();
      expect(originalDirectAddress, 'directAddress must be captured').toBeTruthy();

      // Re-init with the captured mnemonic. The fresh wallet should
      // derive the EXACT same directAddress — this is the load-
      // bearing determinism guarantee of the wallet-recovery flow.
      const reinit = runSphere(
        env,
        ['wallet', 'init', '--network', 'testnet', '--mnemonic', capturedMnemonic!],
        { timeoutMs: 120_000 },
      );
      if (reinit.status !== 0) {
        console.error('reinit failed', { stdout: reinit.stdout, stderr: reinit.stderr });
      }
      expect(reinit.status).toBe(0);

      const addrMatch = reinit.stdout.match(/"directAddress":\s*"(DIRECT:\/\/[0-9a-fA-F]+)"/);
      expect(addrMatch, `directAddress not in reinit:\n${reinit.stdout}`).toBeTruthy();
      // THE DETERMINISM PIN: same mnemonic → same directAddress.
      // A regression in BIP-39 → seed → HD-path → secp256k1 → bech32
      // pipeline anywhere along that chain would flip this red.
      expect(addrMatch![1]).toBe(originalDirectAddress);

      // Belt-and-braces: the on-disk wallet.json now exists again,
      // populated from the imported mnemonic.
      expect(existsSync(join(env.home, '.sphere-cli', 'wallet.json'))).toBe(true);
    }, 180_000);
  },
);

describe.skipIf(integrationSkip)(
  'sphere-cli integration — init --nametag combined flow (real testnet)',
  () => {
    // Pins the init-time nametag registration. This is a combined flow:
    // `init --nametag X` runs Sphere.init({ nametag: X }) which both
    // creates the wallet AND mints the nametag in one shot. The legacy
    // CLI's `init` case (~line 1640) propagates `nametag` into the
    // getSphere() options bag; the SDK's Sphere.init then calls
    // registerNametag() on success.
    //
    // Standalone `nametag register` is already covered in
    // cli-nametag.integration.test.ts. This test ADDS coverage of the
    // combined flow because the two paths fail differently:
    //   - register-after-init: wallet exists; failure rolls back nothing.
    //   - init --nametag: failure mid-mint leaves wallet+nametag in a
    //     potentially inconsistent state (wallet stored, nametag
    //     unregistered locally). Sphere.init handles this defensively;
    //     we pin the happy path here.
    let env: SphereEnv;
    const nametag = `it_${randomBytes(4).toString('hex')}`;

    beforeAll(() => { env = createSphereEnv('init-nametag-combined'); });
    afterAll(() => { if (env) destroySphereEnv(env); });

    it(`\`sphere init --nametag ${nametag}\` mints the nametag during wallet creation`, () => {
      const r = runSphere(
        env,
        ['init', '--network', 'testnet', '--nametag', nametag],
        { timeoutMs: 240_000 },
      );
      if (r.status !== 0) {
        console.error('init --nametag failed', { stdout: r.stdout, stderr: r.stderr });
      }
      expect(r.status).toBe(0);
      // The identity block (~line 1654) must include the registered
      // nametag in the JSON output. If init succeeds but nametag mint
      // fails silently, the field would be null/absent here.
      expect(r.stdout).toMatch(new RegExp(`"nametag":\\s*"${nametag}"`));
      // The wallet directory now exists on disk.
      expect(existsSync(join(env.home, '.sphere-cli', 'wallet.json'))).toBe(true);
    }, 300_000);

    it('`sphere nametag my` reports the registered nametag after init --nametag', () => {
      // Re-verify via a different code path: read the nametag via the
      // dedicated query command. If `init --nametag` registered the
      // mint on-chain but didn't persist the binding locally, this
      // would show "No nametag registered" instead of the value.
      const r = runSphere(env, ['nametag', 'my'], { timeoutMs: 60_000 });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(nametag);
    }, 90_000);
  },
);
