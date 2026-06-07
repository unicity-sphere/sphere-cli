/**
 * Issue #32 — UX consistency guard.
 *
 * These tests don't exercise SDK behaviour; they inspect the static
 * surface of `legacy-cli.ts` (regex over the source) to keep the
 * canonical UX invariants from drifting back to legacy patterns.
 *
 * Invariants enforced:
 *   1. No `console.log(JSON.stringify(...))` in the dispatch body —
 *      output must route through `formatOutput()` so `--json` works.
 *   2. No `console.error('Usage: …'); process.exit(…)` pattern —
 *      validation failures must call `failWithHelp(...)` so the full
 *      help block prints (Pass E).
 *   3. No `parseAssetArg(` calls — asset input is canonical
 *      `consumeAssetPair(args, idx)` everywhere (Pass B).
 *   4. Every entry in the COMMAND_HELP registry appears in the shell
 *      completion list (or is registered as a sub-subcommand of a
 *      completion entry that lists `subcommands`).
 *
 * If any of these regress, the regex will fire and the test will
 * report the offending file:line. The CLI must stay consistent.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SOURCE_PATH = path.resolve(__dirname, 'legacy-cli.ts');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');
const LINES = SOURCE.split('\n');

/** Return `{ line, text }` for each line that matches `re`. */
function findMatches(re: RegExp): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  for (let i = 0; i < LINES.length; i++) {
    if (re.test(LINES[i])) out.push({ line: i + 1, text: LINES[i].trim() });
  }
  return out;
}

describe('issue #32 — UX consistency', () => {
  it('no console.log(JSON.stringify(...)) in dispatch body — must use formatOutput()', () => {
    // The implementation of formatOutput() itself legitimately calls
    // console.log(JSON.stringify(...)) — that's the `--json` branch.
    // Locate that function so we can exclude its body from the scan.
    const formatStart = LINES.findIndex(l => /^function formatOutput\(/.test(l));
    expect(formatStart, 'formatOutput() helper definition not found').toBeGreaterThan(-1);
    // Helper is small — closing brace at column 0 within ~20 lines.
    let formatEnd = formatStart;
    for (let i = formatStart + 1; i < Math.min(LINES.length, formatStart + 40); i++) {
      if (/^\}/.test(LINES[i])) { formatEnd = i; break; }
    }
    const matches = findMatches(/console\.log\(\s*JSON\.stringify/);
    const offenders = matches.filter(m => {
      // Outside the formatOutput body
      const inFormatOutput = m.line > formatStart && m.line <= formatEnd + 1;
      return !inFormatOutput;
    });
    expect(offenders, `Found ${offenders.length} stray console.log(JSON.stringify(...)) sites:\n${
      offenders.map(o => `  L${o.line}: ${o.text}`).join('\n')
    }\nReplace with formatOutput(value, '<shape>', '<label>') so --json works.`).toEqual([]);
  });

  it('no console.error("Usage: ...") / process.exit(1) pattern — must use failWithHelp()', () => {
    const matches = findMatches(/console\.error\(['"`]Usage:/);
    expect(matches, `Found ${matches.length} legacy "Usage:" stubs:\n${
      matches.map(m => `  L${m.line}: ${m.text}`).join('\n')
    }\nReplace with failWithHelp('<cmd>', '<error>') so the full help block prints.`).toEqual([]);
  });

  it('no parseAssetArg() call sites — asset input is consumeAssetPair() everywhere', () => {
    // Allow the helper to be referenced in comments/docs only.
    const matches = findMatches(/parseAssetArg\(/);
    const offenders = matches.filter(m => !/^\s*\/[/*]/.test(m.text));
    expect(offenders, `Found ${offenders.length} parseAssetArg() calls — drop legacy quoted form, use consumeAssetPair(args, i + 1).`).toEqual([]);
  });

  it('every COMMAND_HELP key is reachable via the completion generator', () => {
    // Parse top-level COMMAND_HELP keys + compound keys.
    const helpKeys = new Set<string>();
    const helpBlockStart = SOURCE.indexOf('const COMMAND_HELP');
    const helpBlockEnd = SOURCE.indexOf('};\n\n/**\n * Print', helpBlockStart);
    const helpBlock = SOURCE.slice(helpBlockStart, helpBlockEnd);
    const helpRe = /^ {2}'([^']+)':\s*{/gm;
    let hm: RegExpExecArray | null;
    while ((hm = helpRe.exec(helpBlock))) helpKeys.add(hm[1]);

    // Parse completion structure
    const compStart = SOURCE.indexOf('function getCompletionCommands');
    const compEnd = SOURCE.indexOf('function generateBash', compStart);
    const compBlock = SOURCE.slice(compStart, compEnd);
    // Collect every `name: '...'` — this captures both top-level and subcommands.
    const compNames = new Set<string>();
    const compRe = /name:\s*'([^']+)'/g;
    let cm: RegExpExecArray | null;
    while ((cm = compRe.exec(compBlock))) compNames.add(cm[1]);

    // For every COMMAND_HELP key, ensure at least one component is present.
    const missing: string[] = [];
    for (const key of helpKeys) {
      const parts = key.split(' ');
      // Compound key "wallet create" satisfied if BOTH 'wallet' and 'create'
      // appear (the second as a subcommand entry under the first).
      const allPresent = parts.every(p => compNames.has(p));
      if (!allPresent) missing.push(key);
    }

    expect(missing, `Completion generator is missing entries for:\n${
      missing.map(k => `  - ${k}`).join('\n')
    }\nAdd them to getCompletionCommands() so tab-completion stays in sync.`).toEqual([]);
  });

  it('formatOutput and failWithHelp helpers exist', () => {
    expect(SOURCE).toMatch(/function formatOutput\(/);
    expect(SOURCE).toMatch(/function failWithHelp\(/);
    expect(SOURCE).toMatch(/function consumeAssetPair\(/);
  });

  it('--json global flag is wired in the early dispatch shim', () => {
    expect(SOURCE).toMatch(/jsonMode = args\.includes\('--json'\)/);
  });

  it('--help / -h early dispatch shim is wired before the switch', () => {
    expect(SOURCE).toMatch(/args\.includes\('--help'\)\s*\|\|\s*args\.includes\('-h'\)/);
  });
});

describe('issue #40 item #1 — bulk-return amount display', () => {
  // Static-analysis pin for the bulk-refund render bug:
  //
  //   `sphere invoice return <id>` (no flags / --recipient form) used to
  //   call `getInvoiceStatus()` AFTER `returnAllInvoicePayments()`. By
  //   that point the SDK had drained `senderBalances[].netBalance` to 0
  //   (refunds had been issued), so every refund row in the rendered
  //   output showed `amount: "0"`. Fix: snapshot status BEFORE the SDK
  //   call so we render the actual refunded amounts.
  //
  //   Pin: inside the `case 'invoice-return':` block, the first
  //   `getInvoiceStatus(` call must appear BEFORE the first
  //   `returnAllInvoicePayments(` call. Source ordering reflects
  //   execution ordering here — both are top-level `await`s, no
  //   conditional skips between them.

  it('getInvoiceStatus is called BEFORE returnAllInvoicePayments in invoice-return', () => {
    const caseStart = SOURCE.indexOf("case 'invoice-return':");
    expect(caseStart, "case 'invoice-return': not found").toBeGreaterThan(-1);

    // Locate end of case — next top-level `case '...'` or `default:` token.
    const after = SOURCE.slice(caseStart + 1);
    const nextCaseRel = after.search(/\n {6}case '[^']+':|\n {6}default:/);
    const caseEnd = nextCaseRel >= 0 ? caseStart + 1 + nextCaseRel : SOURCE.length;
    const block = SOURCE.slice(caseStart, caseEnd);

    // Match the actual `await sphere.accounting!.<method>(` call sites,
    // not bare `<method>(` (would also match comment references like
    // "iterates `getInvoiceStatus().senderBalances` internally").
    const statusCallRe   = /await\s+sphere\.accounting!?\.getInvoiceStatus\s*\(/;
    const returnAllRe    = /await\s+sphere\.accounting!?\.returnAllInvoicePayments\s*\(/;
    const statusMatch    = statusCallRe.exec(block);
    const returnAllMatch = returnAllRe.exec(block);

    expect(
      statusMatch,
      'getInvoiceStatus() call missing from invoice-return — bulk-refund render needs the pre-refund snapshot.',
    ).not.toBeNull();
    expect(
      returnAllMatch,
      'returnAllInvoicePayments() call missing from invoice-return — Form B/C delegates to the SDK.',
    ).not.toBeNull();
    expect(
      statusMatch!.index,
      'getInvoiceStatus() must be called BEFORE returnAllInvoicePayments() so renderer shows pre-refund amounts (issue #40 item #1).',
    ).toBeLessThan(returnAllMatch!.index);
  });
});
