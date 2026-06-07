/**
 * Integration test: `sphere payments {addresses,switch,hide,unhide}` —
 * multi-address surface, with explicit proof of cross-address ISOLATION.
 *
 * This test pins two distinct concerns:
 *
 *   A) **CLI plumbing** — namespace bridge, arg validation, help text
 *      for the four multi-address commands.
 *
 *   B) **Token / asset isolation invariant** — tokens belonging to
 *      address #N must NEVER be visible from address #M (N ≠ M) after
 *      a `switch`. This is a security-critical guarantee: a leak would
 *      mean a user who switched to a fresh address could accidentally
 *      spend tokens that belong to a different HD branch (or vice-versa,
 *      receive tokens into the wrong branch and lose track of them).
 *
 *      The architectural mechanism for this is per-address token
 *      storage: in Node.js the FileTokenStorageProvider keeps a
 *      separate `tokens/<addressId>/` subdirectory per tracked
 *      address (in the browser, `sphere-token-storage-{addressId}`).
 *      `sphere.payments.getTokens()` always reads from the storage
 *      bound to the currently-active address — so as long as the
 *      directory split is honoured, isolation holds.
 *
 *      We pin this two ways:
 *        1. **Filesystem inspection (no funding required)** — after
 *           switching from #0 to #1, the on-disk `tokens/` directory
 *           must contain TWO distinct subdirectories. If the SDK ever
 *           regresses to a single shared store, this flips red without
 *           needing real tokens.
 *        2. **End-to-end token visibility (gated by E2E_RUN_FAUCET=1)** —
 *           faucet 1 UCT at #0, switch to #1, confirm `payments tokens`
 *           shows "No tokens found", switch back to #0, confirm the UCT
 *           is still there. This is the gold-standard proof — it
 *           catches any regression that breaks the per-address read
 *           binding, not just the directory split.
 *
 * Four layers of pins:
 *
 *   1. **Help-shape pins (offline, 4 tests)** — one per command.
 *      legacy-cli.ts HELP_TEXT keys: addresses / switch / hide / unhide
 *      (~lines 707-735).
 *
 *   2. **Arg-validation pins (offline, 4 tests)** — switch/hide/unhide
 *      validate `args[1]` BEFORE getSphere() (~lines 2538, 2565, 2579).
 *      switch additionally checks `isNaN(index) || index < 0` after
 *      parsing (~line 2545). Both guards run before any wallet load.
 *
 *   3. **Stateful local lifecycle (network-light, ~6 tests)** — fresh
 *      wallet → addresses shows #0 → switch 1 creates + activates #1
 *      → addresses lists both → on-disk `tokens/` has two subdirs →
 *      hide/unhide round-trip → switch back to #0.
 *
 *   4. **Token isolation invariant (opt-in, E2E_RUN_FAUCET=1, ~4 tests)** —
 *      see (B) above. Requires registering a nametag (~20s on-chain
 *      mint) plus a faucet call (~5s), so gated.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  createSphereEnv,
  destroySphereEnv,
  expectUsageHint,
  runSphere,
  integrationSkip,
  type SphereEnv,
} from './helpers.js';

/** Opt-in gate for the funded isolation proof. */
const RUN_FAUCET_E2E = process.env['E2E_RUN_FAUCET'] === '1';

/**
 * Help-shape sweep — legacy-cli.ts HELP_TEXT keys for the four
 * multi-address commands and one regex apiece that pins documented
 * behaviour. Keep in sync with HELP_TEXT (~lines 707-735).
 */
const MULTIADDR_HELP_PINS: ReadonlyArray<{
  readonly legacy: string;
  readonly mustMatch: RegExp[];
}> = [
  { legacy: 'addresses', mustMatch: [/tracked/i, /HD/] },
  { legacy: 'switch',    mustMatch: [/<index>/, /HD/i] },
  { legacy: 'hide',      mustMatch: [/<index>/, /hidden/i] },
  { legacy: 'unhide',    mustMatch: [/<index>/, /[Uu]nhide/] },
];

describe('sphere-cli — multiaddress command shape (offline)', () => {
  let env: SphereEnv;

  beforeAll(() => { env = createSphereEnv('multiaddr-help'); });
  afterAll(() => { destroySphereEnv(env); });

  for (const { legacy, mustMatch } of MULTIADDR_HELP_PINS) {
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

describe('sphere-cli — multiaddress arg validation (offline)', () => {
  let env: SphereEnv;

  beforeAll(() => { env = createSphereEnv('multiaddr-args'); });
  afterAll(() => { destroySphereEnv(env); });

  it.each([
    // No-index cases (~lines 2538, 2565, 2579): missing positional →
    // "Usage: <cmd> <index>" exit 1 BEFORE getSphere().
    ['payments switch (no index)',  ['payments', 'switch'],  'switch'],
    ['payments hide (no index)',    ['payments', 'hide'],    'hide'],
    ['payments unhide (no index)',  ['payments', 'unhide'],  'unhide'],
  ])('`sphere %s` prints usage and exits non-zero', (_label, argv, legacyName) => {
    const r = runSphere(env, argv, { timeoutMs: 15_000 });
    expect(r.status).not.toBe(0);
    expectUsageHint(`${r.stdout}\n${r.stderr}`, legacyName, '<index>');
  });

  it('`sphere payments switch abc` rejects non-numeric index with "Invalid index"', () => {
    // The second arg-validation guard in the switch case (~line 2545):
    //   if (isNaN(index) || index < 0) { console.error('Invalid index...'); exit(1); }
    // Runs AFTER `parseInt(indexStr)` but still BEFORE getSphere(), so
    // no wallet load. Pin this to catch refactors that demote it to
    // a "let the SDK reject it" path (which would produce a different
    // error message and a different exit code).
    const r = runSphere(env, ['payments', 'switch', 'abc'], { timeoutMs: 15_000 });
    expect(r.status).not.toBe(0);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).toMatch(/Invalid index/i);
  });
});

describe.skipIf(integrationSkip)(
  'sphere-cli integration — address lifecycle and on-disk isolation (real wallet)',
  () => {
    // One wallet shared across all stateful tests — state evolves: #0
    // (fresh) → switch 1 → #1 active → hide #1 → unhide #1 → switch 0.
    // Tests must run in order. Vitest serializes `it` blocks within a
    // describe by default, so this is safe.
    let env: SphereEnv;
    /** directAddress at index #0, captured during wallet init. */
    let directAddr0: string | null = null;
    /** directAddress at index #1, captured after first switch. */
    let directAddr1: string | null = null;

    beforeAll(() => {
      env = createSphereEnv('multiaddr-lifecycle');
      const init = runSphere(env, ['wallet', 'init', '--network', 'testnet'], { timeoutMs: 120_000 });
      if (init.status !== 0) {
        console.error('wallet init failed', { status: init.status, stdout: init.stdout, stderr: init.stderr });
        throw new Error('wallet init failed; cannot proceed with multiaddress lifecycle');
      }
      const match = init.stdout.match(/directAddress\s*:\s*(DIRECT:\/\/[0-9a-fA-F]+)/);
      if (!match) throw new Error(`directAddress not found in init output:\n${init.stdout}`);
      directAddr0 = match[1]!;
    }, 180_000);

    afterAll(() => { if (env) destroySphereEnv(env); });

    it('`sphere payments addresses` on fresh wallet shows only #0 (active)', () => {
      const r = runSphere(env, ['payments', 'addresses'], { timeoutMs: 60_000 });
      expect(r.status).toBe(0);
      // Header + footer pin the output frame shape (separator widths
      // are load-bearing for column-aligned scrapers).
      expect(r.stdout).toMatch(/Tracked Addresses:/);
      // The active marker `→ ` precedes the active address line. On
      // a fresh wallet, only #0 exists and is active.
      expect(r.stdout).toMatch(/→\s*#0:/);
      // No #1 line should exist yet — proves we're not seeing stale
      // state from a prior run leaking into this test.
      expect(r.stdout).not.toMatch(/#1:/);
    }, 120_000);

    it('`sphere payments switch 1` activates a new address with a DIFFERENT directAddress', () => {
      const r = runSphere(env, ['payments', 'switch', '1'], { timeoutMs: 60_000 });
      if (r.status !== 0) {
        console.error('switch 1 failed', { stdout: r.stdout, stderr: r.stderr });
      }
      expect(r.status).toBe(0);
      // Confirmation line from the switch case (~line 2554).
      expect(r.stdout).toMatch(/Switched to address #1/);
      const match = r.stdout.match(/DIRECT:\s+(DIRECT:\/\/[0-9a-fA-F]+)/);
      expect(match, `directAddress not in switch output:\n${r.stdout}`).toBeTruthy();
      directAddr1 = match![1]!;
      // ISOLATION INVARIANT — pin 1: HD derivation MUST produce a
      // different directAddress for index #1 than #0. If two HD
      // indices ever derive to the same address, address-level
      // separation is broken at the cryptographic layer.
      expect(directAddr1).not.toBe(directAddr0);
    }, 120_000);

    it('`sphere payments addresses` after switch lists BOTH #0 and #1 with #1 active', () => {
      const r = runSphere(env, ['payments', 'addresses'], { timeoutMs: 60_000 });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/#0:/);
      // Active marker now precedes #1, not #0.
      expect(r.stdout).toMatch(/→\s*#1:/);
      // And the inverse — #0 line should be present but NOT marked
      // active (the marker is `→ ` followed by `#N:`; a non-active
      // line has two spaces or whitespace).
      expect(r.stdout).not.toMatch(/→\s*#0:/);
    }, 120_000);

    it('on-disk per-address token storage: switch creates a SEPARATE tokens/ subdirectory', () => {
      // ISOLATION INVARIANT — pin 2: Node.js FileTokenStorageProvider
      // keeps a separate `tokens/<addressId>/` per tracked address.
      // After init at #0 + switch to #1, the tokens dir MUST contain
      // exactly two subdirectories. A regression that shares one
      // store across HD branches would shrink this to one entry, and
      // the funded leak test (gated below) would also catch it — but
      // this no-network filesystem pin is the cheapest and earliest
      // signal.
      const tokensDir = join(env.home, '.sphere-cli', 'tokens');
      const subdirs = readdirSync(tokensDir);
      // Each entry should be a DIRECT_<6hex>_<6hex> directory keyed
      // by addressId (see e.g. `DIRECT_000044_9ec9d7`). The exact
      // format isn't load-bearing; what's load-bearing is the count
      // and the fact that they're distinct.
      expect(subdirs.length, `tokens dir should have 2 per-address subdirs after switch, got ${subdirs.length}: ${subdirs.join(', ')}`).toBe(2);
      expect(new Set(subdirs).size, 'address subdirs must be distinct').toBe(2);
      // Belt-and-braces: every subdir name should be DIRECT-shaped.
      // If a non-DIRECT entry sneaks in (e.g. a tempfile dropped at
      // the wrong level), this catches it before it confuses sync.
      for (const dir of subdirs) {
        expect(dir, `unexpected non-address entry in tokens/: ${dir}`).toMatch(/^DIRECT_/);
      }
    });

    it('`sphere payments hide 1` marks #1 [hidden] in the addresses listing', () => {
      const hide = runSphere(env, ['payments', 'hide', '1'], { timeoutMs: 60_000 });
      expect(hide.status).toBe(0);
      expect(hide.stdout).toMatch(/Address #1 hidden/);

      const list = runSphere(env, ['payments', 'addresses'], { timeoutMs: 60_000 });
      expect(list.status).toBe(0);
      // The `[hidden]` marker is appended on the address line
      // (legacy-cli.ts ~line 2524). #1 should still be the active
      // address (hide doesn't change active selection) but now
      // tagged as hidden.
      expect(list.stdout).toMatch(/#1:.*\[hidden\]/);
    }, 120_000);

    it('`sphere payments unhide 1` removes the [hidden] marker', () => {
      const unhide = runSphere(env, ['payments', 'unhide', '1'], { timeoutMs: 60_000 });
      expect(unhide.status).toBe(0);
      expect(unhide.stdout).toMatch(/Address #1 unhidden/);

      const list = runSphere(env, ['payments', 'addresses'], { timeoutMs: 60_000 });
      expect(list.status).toBe(0);
      // #1 line should be present without the [hidden] suffix.
      // Match #1's full line and assert "hidden" is absent from it.
      const line1 = list.stdout.split('\n').find((l) => /^\s*[→\s]?\s*#1:/.test(l));
      expect(line1, `no #1 line in addresses output:\n${list.stdout}`).toBeTruthy();
      expect(line1!).not.toMatch(/\[hidden\]/);
    }, 120_000);

    it('`sphere payments switch 0` returns to the original directAddress (no leak)', () => {
      const r = runSphere(env, ['payments', 'switch', '0'], { timeoutMs: 60_000 });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/Switched to address #0/);
      // ISOLATION INVARIANT — pin 3: HD derivation is deterministic.
      // Switching back to #0 must reproduce the exact original
      // directAddress — proves wallet state for #0 was preserved
      // intact while we were operating on #1, and confirms no
      // cross-pollination of identity material.
      const match = r.stdout.match(/DIRECT:\s+(DIRECT:\/\/[0-9a-fA-F]+)/);
      expect(match, `directAddress not in switch output:\n${r.stdout}`).toBeTruthy();
      expect(match![1]).toBe(directAddr0);
    }, 120_000);
  },
);

describe.skipIf(integrationSkip || !RUN_FAUCET_E2E)(
  'sphere-cli integration — token isolation across addresses (E2E_RUN_FAUCET=1)',
  () => {
    // Funded proof of the isolation invariant. Requires:
    //   - wallet init (~5s)
    //   - on-chain nametag mint (~20s — required by faucet)
    //   - faucet request (~5s)
    //   - 3 token-list calls (~1s each)
    // Total: ~35s for the full leak-proof loop.
    let env: SphereEnv;
    const randomName = `it_${randomBytes(4).toString('hex')}`;

    beforeAll(async () => {
      env = createSphereEnv('multiaddr-isolation-live');

      const init = runSphere(env, ['wallet', 'init', '--network', 'testnet'], { timeoutMs: 120_000 });
      if (init.status !== 0) throw new Error(`wallet init failed:\n${init.stderr}`);

      const reg = runSphere(env, ['nametag', 'register', randomName], { timeoutMs: 180_000 });
      if (reg.status !== 0) throw new Error(`nametag register failed:\n${reg.stderr}`);

      const faucet = runSphere(env, ['faucet', '1', 'UCT'], { timeoutMs: 60_000 });
      if (faucet.status !== 0 || !/Received/i.test(faucet.stdout)) {
        throw new Error(`faucet failed:\n${faucet.stdout}\n${faucet.stderr}`);
      }

      // The faucet API returns "Received" as soon as the gift-wrap is
      // queued on the relay — NOT when the wallet has finalized the
      // token into local storage. Poll `payments tokens` (with sync)
      // until the UCT lands at #0; otherwise the first test reads an
      // empty token list. Each poll is one wallet-load + receive
      // round-trip (~10-30s), so we cap retries at 3 (max ~90s).
      // The subsequent isolation tests use `--no-sync` for fast reads
      // once we've confirmed the token is locally present.
      for (let attempt = 1; attempt <= 3; attempt++) {
        const probe = runSphere(env, ['payments', 'tokens'], { timeoutMs: 60_000 });
        if (probe.status === 0 && /Coin:\s*UCT/.test(probe.stdout)) {
          return;
        }
        if (attempt === 3) {
          throw new Error(
            `UCT token never landed at #0 after faucet (3 attempts):\n` +
              `stdout: ${probe.stdout}\nstderr: ${probe.stderr}`,
          );
        }
        // Brief gap before retrying — gives the relay a chance to
        // deliver the gift-wrap if it was just queued.
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    }, 360_000);

    afterAll(() => { if (env) destroySphereEnv(env); });

    it('`payments tokens --no-sync` at #0 lists the faucet-received UCT', () => {
      // beforeAll's poll loop already confirmed UCT is in local
      // storage. Use --no-sync here to skip the receive() round-trip
      // and assert purely on the persisted per-address state.
      const r = runSphere(env, ['payments', 'tokens', '--no-sync'], { timeoutMs: 60_000 });
      expect(r.status).toBe(0);
      // The faucet sends UCT; the tokens dump prints "Coin: UCT (...)".
      // Match the UCT mention without binding to the truncated coinId
      // format ("455ad872..." prefix).
      expect(r.stdout).toMatch(/Coin:\s*UCT/);
    }, 120_000);

    it('switch to #1 → `payments tokens` shows NO tokens (isolation enforced)', () => {
      // THE LEAK TEST. If `sphere.payments.getTokens()` ever returns
      // tokens from a different address's storage, this flips red.
      const sw = runSphere(env, ['payments', 'switch', '1'], { timeoutMs: 60_000 });
      expect(sw.status).toBe(0);
      expect(sw.stdout).toMatch(/Switched to address #1/);

      const r = runSphere(env, ['payments', 'tokens', '--no-sync'], { timeoutMs: 60_000 });
      expect(r.status).toBe(0);
      // Exact wording from legacy-cli.ts ~line 2050. If a regression
      // produces a token list here, the negative assertion below
      // catches it; the positive "No tokens found" pin documents the
      // expected user-facing message.
      expect(r.stdout).toMatch(/No tokens found/);
      // Belt-and-braces — there must be NO "Coin:" line, which would
      // signal a token leaked through from #0's storage.
      expect(r.stdout).not.toMatch(/Coin:/);
    }, 120_000);

    it('switch back to #0 → UCT token is STILL there (state preserved across switches)', () => {
      const sw = runSphere(env, ['payments', 'switch', '0'], { timeoutMs: 60_000 });
      expect(sw.status).toBe(0);

      const r = runSphere(env, ['payments', 'tokens', '--no-sync'], { timeoutMs: 60_000 });
      expect(r.status).toBe(0);
      // The token must still be visible at #0 — proves the round-trip
      // through #1 didn't drop, mutate, or migrate it.
      expect(r.stdout).toMatch(/Coin:\s*UCT/);
    }, 120_000);
  },
);
