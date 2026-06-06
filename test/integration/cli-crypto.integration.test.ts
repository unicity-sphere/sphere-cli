/**
 * Integration test: `sphere crypto …` + `sphere util …` — client-side
 * helpers that DON'T touch the wallet or any network.
 *
 * Backstop for the CLI extraction: the crypto/util surface is pure
 * cryptography + format conversion, but the legacy dispatcher in
 * `src/legacy/legacy-cli.ts` is where bugs land — wrong arg order,
 * silent precondition checks, hex/WIF/base58 mis-encoding, etc. This
 * file pins:
 *
 *   1. **Help-shape pins (offline)** — every crypto/util subcommand
 *      with a HELP_TEXT entry. Confirms the help text isn't accidentally
 *      dropped in a refactor and that the documented usage line + key
 *      positionals are present.
 *
 *   2. **Arg-validation pins (offline)** — every subcommand that
 *      validates positionals BEFORE calling `getSphere()`. Bare
 *      invocation should error with the usage hint, not load the wallet.
 *
 *   3. **Behaviour pins (offline)** — actual output shape for the
 *      load-bearing client-side conversions:
 *        - generate-key emits a valid pubkey + address, hides secrets
 *        - --unsafe-print refuses non-TTY (security pin: prevents
 *          unintended secret leakage to vitest log files)
 *        - validate-key true/false output shape
 *        - hex-to-wif → WIF format roundtrips via base58
 *        - derive-pubkey is deterministic
 *        - derive-address is deterministic per index
 *        - base58-encode/decode roundtrip
 *        - encrypt/decrypt roundtrip
 *        - to-smallest/to-human roundtrip (no coin, uses 8-decimal default)
 *
 * No wallet, no network, no sphere init. All tests under ~5s total.
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
 * Stable test private key. 64-char hex, deterministic — used so derive-
 * pubkey / derive-address output is the same across runs.
 */
const TEST_PRIVKEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

/**
 * Subcommands of `sphere crypto <sub>` and `sphere util <sub>` that
 * have a HELP_TEXT entry. The mustMatch regexes are the load-bearing
 * documentation surface — users grep for these flags / positionals when
 * scripting against the CLI.
 */
const CRYPTO_SUBCOMMANDS: ReadonlyArray<{
  /** Legacy command name (also HELP_TEXT key). */
  readonly legacy: string;
  /** Regex(es) that MUST appear in help output. */
  readonly mustMatch: RegExp[];
}> = [
  { legacy: 'generate-key',   mustMatch: [/Usage:.*generate-key/, /secp256k1/i] },
  { legacy: 'validate-key',   mustMatch: [/<hex>/, /valid.*secp256k1/i] },
  { legacy: 'hex-to-wif',     mustMatch: [/<hex>/, /WIF/] },
  { legacy: 'derive-pubkey',  mustMatch: [/<private-key-hex>/, /public key/i] },
  { legacy: 'derive-address', mustMatch: [/<private-key-hex>/, /\[index\]/, /alpha1/] },
  { legacy: 'base58-encode',  mustMatch: [/<hex>/, /Base58/i] },
  { legacy: 'base58-decode',  mustMatch: [/<string>/, /hex/i] },
  { legacy: 'to-smallest',    mustMatch: [/<amount>/, /smallest/i] },
  { legacy: 'to-human',       mustMatch: [/<amount>/, /human/i] },
  { legacy: 'format',         mustMatch: [/<amount>/, /\[decimals\]/] },
  { legacy: 'encrypt',        mustMatch: [/<data>/, /<password>/, /AES/i] },
  { legacy: 'decrypt',        mustMatch: [/<encrypted-json>/, /<password>/] },
];

describe('sphere-cli — crypto/util help shape (offline)', () => {
  let env: SphereEnv;

  beforeAll(() => { env = createSphereEnv('crypto-help'); });
  afterAll(() => { destroySphereEnv(env); });

  for (const { legacy, mustMatch } of CRYPTO_SUBCOMMANDS) {
    it(`\`sphere payments help ${legacy}\` lists documented usage + key tokens`, () => {
      const r = runSphere(env, ['payments', 'help', legacy], { timeoutMs: 15_000 });
      expect(r.status).toBe(0);
      for (const re of mustMatch) {
        expect(r.stdout, `${legacy} help missing ${re}`).toMatch(re);
      }
    });
  }
});

describe('sphere-cli — crypto/util arg validation (offline)', () => {
  // These cases validate positional args BEFORE `getSphere()`. Bare
  // invocation must error with the usage hint without loading wallet
  // state. Pinning prevents a refactor from reordering the check below
  // the wallet load (which would force a "did I type the right
  // command" probe to go through Sphere.init).
  let env: SphereEnv;

  beforeAll(() => { env = createSphereEnv('crypto-args'); });
  afterAll(() => { destroySphereEnv(env); });

  it.each([
    ['validate-key',   'validate-key'],
    ['hex-to-wif',     'hex-to-wif'],
    ['derive-pubkey',  'derive-pubkey'],
    ['derive-address', 'derive-address'],
    ['base58-encode',  'base58-encode'],
    ['base58-decode',  'base58-decode'],
    ['encrypt',        'encrypt'],
    ['decrypt',        'decrypt'],
  ])('`sphere crypto %s` with no args prints usage and exits non-zero', (sub, legacyName) => {
    const r = runSphere(env, ['crypto', sub], { timeoutMs: 15_000 });
    expect(r.status).not.toBe(0);
    expectUsageHint(`${r.stdout}\n${r.stderr}`, legacyName);
  });

  it.each([
    ['to-smallest', 'to-smallest'],
    ['to-human',    'to-human'],
    ['format',      'format'],
  ])('`sphere util %s` with no args prints usage and exits non-zero', (sub, legacyName) => {
    const r = runSphere(env, ['util', sub], { timeoutMs: 15_000 });
    expect(r.status).not.toBe(0);
    expectUsageHint(`${r.stdout}\n${r.stderr}`, legacyName);
  });

  it('`sphere crypto encrypt foo` (missing password) prints usage and exits non-zero', () => {
    // encrypt + decrypt require TWO positionals — missing the second
    // also hits the pre-getSphere() guard.
    const r = runSphere(env, ['crypto', 'encrypt', 'foo'], { timeoutMs: 15_000 });
    expect(r.status).not.toBe(0);
    expectUsageHint(`${r.stdout}\n${r.stderr}`, 'encrypt');
  });
});

describe('sphere-cli — crypto behaviour (offline)', () => {
  let env: SphereEnv;

  beforeAll(() => { env = createSphereEnv('crypto-behaviour'); });
  afterAll(() => { destroySphereEnv(env); });

  it('`sphere --version` prints a semver-ish string', () => {
    const r = runSphere(env, ['--version']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('`sphere crypto generate-key` emits a valid compressed secp256k1 pubkey + alpha1 address', () => {
    const r = runSphere(env, ['crypto', 'generate-key']);
    expect(r.status).toBe(0);
    // Output shape:
    //   Public Key: 03... (or 02...)
    //   Address: alpha1q...
    expect(r.stdout).toMatch(/Public Key:\s*0[23][0-9a-fA-F]{64}/);
    expect(r.stdout).toMatch(/Address:\s*alpha1[a-z0-9]+/);
    // Private key + WIF MUST NOT leak unless --unsafe-print is set AND
    // we're attached to a TTY. The "(private key and WIF hidden ...)"
    // message is the load-bearing user signal.
    expect(r.stdout).not.toMatch(/Private Key:\s*[0-9a-fA-F]{64}\b/);
    expect(r.stdout).toMatch(/private key and WIF hidden/i);
  });

  it('`sphere crypto generate-key --unsafe-print` refuses to print secrets to non-TTY', () => {
    // SECURITY pin: even with --unsafe-print, the handler MUST refuse
    // when stdout is not a TTY (vitest pipes its child's stdout, so
    // isTTY=false). Otherwise the freshly-minted private key would be
    // captured into vitest's log buffer and ultimately the CI artifact.
    //
    // Override path documented in the error message: `--allow-non-tty`.
    // We deliberately do NOT exercise that override here — printing a
    // private key into test output, even a deterministic one, lowers
    // the bar on future "let's just dump the key for debugging".
    const r = runSphere(env, ['crypto', 'generate-key', '--unsafe-print']);
    expect(r.status).not.toBe(0);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).toMatch(/refusing to print private key to non-TTY/i);
    expect(out).toMatch(/--allow-non-tty/);
    // The pubkey + address branch should NOT have run when we refused.
    expect(out).not.toMatch(/Public Key:\s*0[23][0-9a-fA-F]{64}/);
  });

  it('`sphere crypto validate-key <hex>` accepts a valid private key', () => {
    const r = runSphere(env, ['crypto', 'validate-key', TEST_PRIVKEY]);
    expect(r.status).toBe(0);
    // Canonical-UX output is human-friendly labelled blocks
    //   `  valid  : true`
    //   `  length : 64`
    // Pad-aware regex (zero-or-more whitespace around `:`) so future
    // alignment tweaks don't rip these out.
    expect(r.stdout).toMatch(/valid\s*:\s*true/);
    expect(r.stdout).toMatch(/length\s*:\s*64/);
  });

  it('`sphere crypto validate-key not-hex` rejects an invalid key', () => {
    // Per the help text: "Exits with code 0 if valid, 1 if invalid."
    // So we expect non-zero exit AND `valid : false` in the output.
    const r = runSphere(env, ['crypto', 'validate-key', 'not-hex']);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/valid\s*:\s*false/);
  });

  it('`sphere crypto hex-to-wif` produces a stable WIF for the test private key', () => {
    // WIF is base58check of the privkey + version byte. Deterministic.
    // The literal value is pinned so a change to the version byte,
    // base58 alphabet, or checksum derivation flips this red.
    const r = runSphere(env, ['crypto', 'hex-to-wif', TEST_PRIVKEY]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('5HpneLQNKrcznVCQpzodYwAmZ4AoHeyjuRf9iAHAa498rP5kuWb');
  });

  it('`sphere crypto derive-pubkey <privkey>` is deterministic', () => {
    // Same privkey → same pubkey, always. Pin the exact output so a
    // regression in the elliptic library or compression flag flips.
    const r = runSphere(env, ['crypto', 'derive-pubkey', TEST_PRIVKEY]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(
      '034646ae5047316b4230d0086c8acec687f00b1cd9d1dc634f6cb358ac0a9a8fff',
    );
  });

  it('`sphere crypto derive-address <privkey> 0` emits an alpha1 address', () => {
    // Same privkey + same HD index → same alpha1 address.
    const r = runSphere(env, ['crypto', 'derive-address', TEST_PRIVKEY, '0']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^alpha1[a-z0-9]{30,80}$/);
  });

  it('`sphere crypto derive-address` at different indices yields different addresses', () => {
    // Pin BIP-32 HD derivation: same privkey but different index must
    // produce a different address. A regression where index is ignored
    // (or where the derivation path is hardcoded) flips this red.
    const a0 = runSphere(env, ['crypto', 'derive-address', TEST_PRIVKEY, '0']);
    const a1 = runSphere(env, ['crypto', 'derive-address', TEST_PRIVKEY, '1']);
    expect(a0.status).toBe(0);
    expect(a1.status).toBe(0);
    expect(a0.stdout.trim()).not.toBe(a1.stdout.trim());
  });
});

describe('sphere-cli — util behaviour (offline)', () => {
  let env: SphereEnv;

  beforeAll(() => { env = createSphereEnv('util-behaviour'); });
  afterAll(() => { destroySphereEnv(env); });

  it('`sphere util base58-encode` and `base58-decode` roundtrip hex bytes', () => {
    // "Hello" in hex is 48656c6c6f. Pinned so a switch to a different
    // base58 alphabet flips this red. (e.g. Ripple's alphabet differs
    // from Bitcoin's.)
    const enc = runSphere(env, ['util', 'base58-encode', '48656c6c6f']);
    expect(enc.status).toBe(0);
    expect(enc.stdout.trim()).toBe('9Ajdvzr');

    const dec = runSphere(env, ['util', 'base58-decode', '9Ajdvzr']);
    expect(dec.status).toBe(0);
    expect(dec.stdout.trim()).toBe('48656c6c6f');
  });

  it('`sphere util to-smallest` and `to-human` roundtrip through default 8-decimal formatter', () => {
    // No coin specified → default 8 decimals (per legacy-cli.ts:2886).
    // Specifying a coin requires sphere.init for the token registry,
    // so the "offline" path is the no-coin variant.
    const toSmallest = runSphere(env, ['util', 'to-smallest', '1.5']);
    expect(toSmallest.status).toBe(0);
    // bigint literal form is possible (e.g. "150000000n"); strip the
    // trailing 'n' before round-tripping back through to-human.
    const smallest = toSmallest.stdout.trim().replace(/n$/, '');
    expect(smallest).toMatch(/^\d+$/);

    const toHuman = runSphere(env, ['util', 'to-human', smallest]);
    expect(toHuman.status).toBe(0);
    expect(toHuman.stdout.trim()).toBe('1.5');
  });

  it('`sphere crypto encrypt` / `decrypt` roundtrips a string with a password', () => {
    // Pin the AES envelope: encrypt produces a base64 blob
    // ("U2FsdGVkX1+..."), decrypt restores the original plaintext.
    // Failure mode pinned by a regression: a change in the cipher,
    // salt format, or PBKDF2 iteration count would either fail the
    // decrypt or yield a different plaintext.
    //
    // Canonical UX: `crypto encrypt` emits bare base64 (no JSON
    // wrapping) so `crypto encrypt foo pw | crypto decrypt - pw`
    // pipelines naturally. `crypto decrypt` accepts both the bare form
    // AND the JSON-quoted legacy form, so scripts piping `--json`
    // output continue to work.
    const plaintext = 'integration-test-secret';
    const password = 'p4ssw0rd-test';
    const enc = runSphere(env, ['crypto', 'encrypt', plaintext, password]);
    expect(enc.status).toBe(0);
    const ciphertext = enc.stdout.trim();
    expect(ciphertext.length).toBeGreaterThan(2);
    // OpenSSL-compatible AES envelope starts with the magic "Salted__"
    // header, base64-encoded as "U2FsdGVkX1" (zero-pad). Pin the prefix
    // so a switch to a non-OpenSSL-compatible scheme breaks
    // compat-hungry downstream tooling.
    expect(ciphertext).toMatch(/^U2FsdGVkX1/);

    const dec = runSphere(env, ['crypto', 'decrypt', ciphertext, password]);
    expect(dec.status).toBe(0);
    // decrypt prints the plaintext bare (no JSON wrapping).
    expect(dec.stdout).toContain(plaintext);
  });

  it('`sphere crypto decrypt <blob> <wrong-pw>` does NOT yield the original plaintext', () => {
    // CLI DEFECT (documented here; not blocking this test):
    //   The current decrypt handler exits 0 on a wrong password — the
    //   underlying CryptoJS AES-CBC envelope has no HMAC, so a bad key
    //   produces garbled bytes that the handler doesn't validate. A
    //   proper implementation (AES-GCM or HMAC-then-encrypt) would
    //   return non-zero on authenticator failure.
    //
    //   TODO(security): replace the AES-CBC envelope with an
    //   authenticated mode (AES-GCM via Node `crypto.createCipheriv`)
    //   and switch this assertion to `expect(dec.status).not.toBe(0)`.
    //   That change should be a SEPARATE PR with a backwards-compat
    //   shim that keeps `decrypt` accepting both envelopes for a
    //   transition window.
    //
    // What this test pins TODAY:
    //   The decrypted output MUST NOT match the original plaintext.
    //   If a regression ever leaks the key derivation (e.g. uses a
    //   constant IV), a wrong-password decrypt could happen to
    //   coincide with the original plaintext for specific inputs —
    //   this assert catches that pathological case.
    const plaintext = 'integration-test-only-secret';
    const enc = runSphere(env, ['crypto', 'encrypt', plaintext, 'real-password']);
    const ciphertext = enc.stdout.trim();
    const dec = runSphere(env, ['crypto', 'decrypt', ciphertext, 'wrong-password']);
    expect(dec.stdout).not.toContain(plaintext);
  });
});
