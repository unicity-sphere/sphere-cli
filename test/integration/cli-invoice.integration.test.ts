/**
 * Integration test: `sphere invoice ...` — AccountingModule CLI surface.
 *
 * Backstop for the CLI extraction: when the in-tree sphere-sdk CLI was
 * deleted, the invoice/accounting surface lost binary-level coverage even
 * though `AccountingModule` itself is well-tested at the SDK layer (see
 * sphere-sdk `tests/unit/modules/AccountingModule.*.test.ts`). This file
 * pins the CLI plumbing — namespace bridge, arg parsing, exit codes, help
 * text — that sits between the user and the SDK module.
 *
 * Three layers of pins:
 *
 *   1. **Help-shape pins (offline)** — `sphere payments help <legacy-name>`
 *      returns the legacy help block. We assert the documented flags +
 *      positionals so a refactor that renames a flag (e.g. `--target` →
 *      `--to`) flips this red before silently breaking caller scripts.
 *      Cheap (<1s each, no wallet, no network).
 *
 *   2. **Arg-validation pins (offline-ish)** — Several invoice subcommands
 *      validate their first positional BEFORE calling `getSphere()` (see
 *      `src/legacy/legacy-cli.ts` invoice-status / invoice-close /
 *      invoice-cancel / invoice-pay cases). Running them with no id from a
 *      fresh tmp profile exits with "Usage: ..." before any wallet load.
 *      Pinning these guards prevents a refactor from reordering the wallet
 *      load above the arg check (which would force every "did I type the
 *      right command" probe to go through Sphere.init).
 *
 *   3. **End-to-end lifecycle pin (network)** — One real wallet, real
 *      aggregator, real Nostr publish. Drives create → list → status →
 *      close on a self-targeted invoice. Pins the full path:
 *        - namespace bridge (`invoice create` → `invoice-create`)
 *        - `getSphere()` Sphere.init with `accounting: true`
 *        - `sphere.accounting.createInvoice()` mints an on-chain token
 *        - prefix-based id resolution for status/close
 *        - state machine: OPEN → CLOSED transition
 *      Self-targeted because invoice creation does not require a recipient
 *      balance; we just need the address to be valid.
 *
 * Funded payment cycle (create → pay → COVERED) is deliberately NOT pinned
 * here — that requires a funded sender wallet + nametag + multi-process
 * orchestration, which is the SDK module's domain. See sphere-sdk
 * `tests/unit/modules/AccountingModule.lifecycle.test.ts` for that pin.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createSphereEnv,
  destroySphereEnv,
  runSphere,
  integrationSkip,
  type SphereEnv,
} from './helpers.js';

/**
 * Subcommands of `sphere invoice <sub>` and the legacy command name they
 * bridge to. Keep in sync with `src/index.ts` namespace bridge — when a
 * subcommand gets renamed or removed, this map is the single point of
 * update for the help-shape sweep below.
 */
const INVOICE_SUBCOMMANDS: ReadonlyArray<{
  /** Legacy command name (what `payments help <name>` accepts). */
  readonly legacy: string;
  /** Regex(es) that MUST appear in help output — flags, positionals, etc. */
  readonly mustMatch: RegExp[];
}> = [
  {
    legacy: 'invoice-create',
    mustMatch: [/--target/, /--asset/, /--memo/, /--due/, /--terms/, /--nft/, /--delivery/],
  },
  { legacy: 'invoice-import',      mustMatch: [/<token-file>/] },
  { legacy: 'invoice-list',        mustMatch: [/--state/, /--role/, /--limit/, /OPEN/, /CLOSED/] },
  { legacy: 'invoice-status',      mustMatch: [/<id-or-prefix>/] },
  { legacy: 'invoice-close',       mustMatch: [/<id-or-prefix>/, /--auto-return/] },
  { legacy: 'invoice-cancel',      mustMatch: [/<id-or-prefix>/] },
  { legacy: 'invoice-pay',         mustMatch: [/<id-or-prefix>/, /--amount/, /--target-index/] },
  { legacy: 'invoice-return',      mustMatch: [/<id-or-prefix>/, /--recipient/, /--asset/] },
  { legacy: 'invoice-receipts',    mustMatch: [/<id-or-prefix>/] },
  { legacy: 'invoice-notices',     mustMatch: [/<id-or-prefix>/] },
  { legacy: 'invoice-auto-return', mustMatch: [/--enable/, /--disable/, /--invoice/] },
  { legacy: 'invoice-transfers',   mustMatch: [/<id-or-prefix>/] },
  { legacy: 'invoice-export',      mustMatch: [/<id-or-prefix>/] },
  { legacy: 'invoice-parse-memo',  mustMatch: [/<memo-string>/, /INV:/] },
];

describe('sphere-cli — invoice command shape (offline)', () => {
  // One env reused across the offline block — these don't write to disk,
  // and `payments help` doesn't even read the wallet, so a single throwaway
  // home is sufficient and keeps the suite under 5s total offline.
  let env: SphereEnv;

  beforeAll(() => { env = createSphereEnv('invoice-help'); });
  afterAll(() => { destroySphereEnv(env); });

  for (const { legacy, mustMatch } of INVOICE_SUBCOMMANDS) {
    it(`\`sphere payments help ${legacy}\` lists documented flags + positionals`, () => {
      const r = runSphere(env, ['payments', 'help', legacy], { timeoutMs: 15_000 });
      // Help dispatch is offline. If this exits non-zero, the help block
      // for this subcommand was removed from `src/legacy/legacy-cli.ts`'s
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
});

describe('sphere-cli — invoice arg validation (offline)', () => {
  // These cases check args BEFORE `getSphere()` in src/legacy/legacy-cli.ts:
  //   invoice-status (line ~3907), invoice-close (line ~3941),
  //   invoice-cancel, invoice-pay. So missing positional → usage exit
  //   without any wallet load or network call.
  let env: SphereEnv;

  beforeAll(() => { env = createSphereEnv('invoice-args'); });
  afterAll(() => { destroySphereEnv(env); });

  it.each([
    ['status',   'invoice-status'],
    ['close',    'invoice-close'],
    ['cancel',   'invoice-cancel'],
    ['pay',      'invoice-pay'],
    ['return',   'invoice-return'],
    ['receipts', 'invoice-receipts'],
    ['notices',  'invoice-notices'],
    ['transfers','invoice-transfers'],
    ['export',   'invoice-export'],
  ])('`sphere invoice %s` with no id prints usage and exits non-zero', (sub, legacyName) => {
    const r = runSphere(env, ['invoice', sub], { timeoutMs: 15_000 });

    // Exit code is the load-bearing assertion — scripts wrapping
    // `sphere invoice <sub> $id` rely on it for failure detection when
    // $id is empty.
    expect(r.status).not.toBe(0);

    const out = `${r.stdout}\n${r.stderr}`;
    // The legacy CLI prints "Usage: <legacy-name> ..." to stderr. If a
    // refactor moves the arg check below the wallet load, this regex
    // flips red (the user would instead see "No wallet exists ...").
    expect(out, `${sub} should show usage hint`).toMatch(
      new RegExp(`Usage:\\s*${legacyName}|usage:\\s*${legacyName}`, 'i'),
    );
  });

  it('`sphere invoice parse-memo` with no memo prints usage and exits non-zero', () => {
    // parse-memo's case also validates `args[1]` before wallet load.
    const r = runSphere(env, ['invoice', 'parse-memo'], { timeoutMs: 15_000 });
    expect(r.status).not.toBe(0);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).toMatch(/Usage:\s*invoice-parse-memo|usage:\s*invoice-parse-memo/i);
  });
});

describe.skipIf(integrationSkip)(
  'sphere-cli integration — invoice lifecycle (real testnet)',
  () => {
    let env: SphereEnv;
    let directAddress: string | null = null;
    let invoiceId: string | null = null;

    beforeAll(() => {
      env = createSphereEnv('invoice-lifecycle');
      const init = runSphere(env, ['wallet', 'init', '--network', 'testnet'], { timeoutMs: 120_000 });
      if (init.status !== 0) {
        console.error('wallet init failed', { status: init.status, stdout: init.stdout, stderr: init.stderr });
        throw new Error('wallet init failed; cannot proceed with invoice lifecycle tests');
      }
      const match = init.stdout.match(/"directAddress":\s*"(DIRECT:\/\/[0-9a-fA-F]+)"/);
      if (!match) throw new Error(`directAddress not found in init output:\n${init.stdout}`);
      directAddress = match[1]!;
    }, 180_000);

    afterAll(() => { if (env) destroySphereEnv(env); });

    it('`sphere invoice list` on a fresh wallet returns "No invoices found"', () => {
      const r = runSphere(env, ['invoice', 'list'], { timeoutMs: 120_000 });
      if (r.status !== 0) {
        console.error('empty invoice list failed', { stdout: r.stdout, stderr: r.stderr });
      }
      expect(r.status).toBe(0);
      // Exact wording from legacy-cli.ts invoice-list case. If the empty
      // message changes, this pin needs to extend, not delete.
      expect(r.stdout).toMatch(/No invoices found/i);
    }, 180_000);

    it('`sphere invoice create --target <self> --asset "1000000 UCT"` mints an invoice', () => {
      expect(directAddress).toBeTruthy();

      const r = runSphere(
        env,
        ['invoice', 'create', '--target', directAddress!, '--asset', '1000000 UCT', '--memo', 'integration-test'],
        { timeoutMs: 180_000 },
      );

      if (r.status !== 0) {
        console.error('invoice create failed', { stdout: r.stdout, stderr: r.stderr });
      }
      expect(r.status).toBe(0);
      // Legacy CLI prints "Invoice created:" then the JSON.stringify of
      // the result, which includes an `invoiceId` field. Extract it for
      // the downstream status / close pins.
      expect(r.stdout).toMatch(/Invoice created:/);
      const idMatch = r.stdout.match(/"invoiceId":\s*"([0-9a-fA-F]+)"/);
      expect(idMatch, `invoiceId not found in output:\n${r.stdout}`).toBeTruthy();
      invoiceId = idMatch![1]!;
      // Invoice token id is hex, ≥ 64 chars (state-transition-sdk token
      // ids are prefixed by a fixed-length type tag in front of the
      // 32-byte content hash, so the on-the-wire form is longer than the
      // SHA-256 used for memo refs). Pin "hex-only, sane length" — a
      // regression that returns a truncated/empty id or a non-hex token
      // id flips red without overfitting to the exact prefix scheme.
      expect(invoiceId).toMatch(/^[0-9a-f]{64,80}$/);
    }, 240_000);

    it('`sphere invoice list` shows the freshly created invoice', () => {
      expect(invoiceId).toBeTruthy();
      const r = runSphere(env, ['invoice', 'list'], { timeoutMs: 120_000 });
      expect(r.status).toBe(0);
      // Output lists `ID: <full-id>` for each invoice (see legacy-cli.ts
      // invoice-list output block). Match on the prefix we captured.
      expect(r.stdout).toContain(invoiceId!);
      expect(r.stdout).toMatch(/Invoices \(1\)/);
    }, 180_000);

    it('`sphere invoice status <prefix>` reports state OPEN with no payments', () => {
      expect(invoiceId).toBeTruthy();
      // Use the documented 8-char prefix shape from the help examples
      // (`invoice-status a1b2c3d4`). Pins the prefix-resolution path
      // through `getInvoices().filter(startsWith)` in invoice-status.
      const prefix = invoiceId!.slice(0, 12);
      const r = runSphere(env, ['invoice', 'status', prefix], { timeoutMs: 120_000 });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/Invoice Status:/);
      // OPEN is the entry state — invoice was just minted, no payments yet.
      expect(r.stdout).toMatch(/"state":\s*"OPEN"/);
    }, 180_000);

    // Regression pin for sphere-cli #21: `sphere invoice status <prefix>` for
    // a prefix that doesn't match any local invoice used to crash with
    //
    //   Error: Cannot read properties of undefined (reading 'invoiceId')
    //
    // The handler called `process.exit(1)` and then dereferenced `matched[0]`,
    // but the legacy-cli's process.exit wrapper scheduled an async destroy
    // and returned `undefined` instead of terminating — so control flow
    // continued past the exit call and crashed on the empty match array.
    //
    // Expected after the ExitSignal interceptor refactor: clean exit code 1
    // with only the "No invoice found matching prefix" message on stderr,
    // and no Node.js TypeError stack trace anywhere in the output.
    //
    // The same fall-through pattern affects every other `invoice-*` command
    // that does `process.exit(1)` after `await getSphere()` — `close`,
    // `cancel`, `pay`, etc. We pin status here because it's the simplest
    // shape; the wrapper fix is shared across them.
    it('`sphere invoice status <unknown-prefix>` exits cleanly without crashing (#21)', () => {
      // A 64-hex prefix that almost certainly doesn't match anything in the
      // freshly-minted wallet. We don't care which prefix as long as it
      // doesn't accidentally collide with `invoiceId` — guarded below.
      const bogus = '00005eb450a21d54f6d77b3c352a26a7539cc453ccdb1d1928dcdb6a0a266ca31e82';
      if (invoiceId && invoiceId.startsWith(bogus.slice(0, 8))) {
        // Astronomically unlikely (8-hex collision on a fresh wallet with
        // one invoice), but skip rather than fail if it ever happens.
        return;
      }
      const r = runSphere(env, ['invoice', 'status', bogus], { timeoutMs: 120_000 });

      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/No invoice found matching prefix:/);
      // The crash signature from #21. If this match flips green, the
      // process.exit wrapper has regressed back to its pre-#21 form.
      const combined = `${r.stdout}\n${r.stderr}`;
      expect(combined).not.toMatch(/Cannot read properties of undefined/);
      expect(combined).not.toMatch(/TypeError/);
    }, 180_000);

    // Companion pins for the other invoice-* commands that share the same
    // `process.exit(1)` fall-through shape. We only assert exit-code + no
    // crash signature — each command's own usage / state-machine semantics
    // are pinned by tests above and by sphere-sdk's AccountingModule unit
    // tests. The intent here is purely to catch the wrapper regression
    // surfacing on any of these handlers.
    it.each([
      ['close'],
      ['cancel'],
      ['pay'],
    ])('`sphere invoice %s <unknown-prefix>` exits cleanly without crashing (#21)', (sub) => {
      const bogus = '00005eb450a21d54f6d77b3c352a26a7539cc453ccdb1d1928dcdb6a0a266ca31e82';
      const r = runSphere(env, ['invoice', sub, bogus], { timeoutMs: 120_000 });
      expect(r.status).not.toBe(0);
      const combined = `${r.stdout}\n${r.stderr}`;
      expect(combined).not.toMatch(/Cannot read properties of undefined/);
      expect(combined).not.toMatch(/TypeError/);
    }, 180_000);

    it('`sphere invoice close <prefix>` moves the invoice to CLOSED', () => {
      expect(invoiceId).toBeTruthy();
      const prefix = invoiceId!.slice(0, 12);
      const r = runSphere(env, ['invoice', 'close', prefix], { timeoutMs: 180_000 });
      if (r.status !== 0) {
        console.error('invoice close failed', { stdout: r.stdout, stderr: r.stderr });
      }
      expect(r.status).toBe(0);

      // Verify the state transition stuck — `invoice status` now reports CLOSED.
      const status = runSphere(env, ['invoice', 'status', prefix], { timeoutMs: 120_000 });
      expect(status.status).toBe(0);
      expect(status.stdout).toMatch(/"state":\s*"CLOSED"/);
    }, 360_000);
  },
);
