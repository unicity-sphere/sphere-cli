#!/usr/bin/env node
/**
 * Sphere CLI — top-level command dispatcher.
 *
 * Command tree (phase 1 scaffold shows only `--version` + help):
 *   sphere wallet      — wallet lifecycle (init, status, list, use, ...)
 *   sphere balance     — balances, tokens, assets
 *   sphere payments    — send, receive, history
 *   sphere dm          — direct-message send/inbox/history
 *   sphere market      — post, search, close intents
 *   sphere swap        — P2P token swap lifecycle
 *   sphere invoice     — invoicing / accounting
 *   sphere host        — HMCP commands: controller → host manager (over DM)
 *   sphere tenant      — ACP commands: controller → tenant (over DM, host-agnostic)
 *   sphere daemon      — long-running event listener
 *   sphere config      — CLI configuration (profiles, relays, manager nametag)
 *
 * Phase 2: legacy sphere-sdk CLI wired under all namespaces.
 * Phase 4: real DM-native commands replace legacy.
 */

import { Command } from 'commander';
import { VERSION } from './version.js';
import { createHostCommand } from './host/host-commands.js';

// Legacy namespaces that delegate to the sphere-sdk CLI dispatcher.
// These are wired in phase 2 and replaced command-by-command in phase 4+.
const LEGACY_NAMESPACES = new Set([
  'wallet', 'balance', 'payments', 'dm', 'group', 'market', 'swap',
  'invoice', 'nametag', 'crypto', 'util', 'faucet', 'daemon', 'config',
  'completions',
]);

// Phase 4 namespaces — DM-native, not yet implemented.
const PHASE4_NAMESPACES: Array<[string, string]> = [
  ['tenant', 'ACP: controller → tenant (over DM, host-agnostic)'],
];

/**
 * Translate a commander namespace + subcommand into the argv shape that the
 * legacy sphere-sdk CLI switch/case dispatcher expects.
 *
 * The legacy dispatcher reads `args[0]` as `command`. Different commander
 * namespaces require different translations:
 *   - `wallet`, `balance`, `daemon`, `config`, `completions` map 1:1.
 *   - `faucet` rewrites to `topup`.
 *   - `nametag <sub>` expands to legacy flat commands (`nametag-info`, etc.).
 *   - `payments`, `crypto`, `util` strip the namespace entirely (their subs
 *     are already legacy top-level commands like `send`, `to-human`, ...).
 *   - `dm`, `group`, `market`, `swap`, `invoice` prefix the subcommand with
 *     `<namespace>-` (e.g. `sphere swap propose` → `swap-propose`).
 */
function buildLegacyArgv(namespace: string): string[] {
  // tail = everything after: node sphere <namespace>
  const tail = process.argv.slice(3);

  switch (namespace) {
    // These namespaces directly match legacy top-level commands — keep namespace as command
    case 'wallet':      return ['wallet',      ...tail];
    case 'balance':     return ['balance',     ...tail];
    case 'daemon':      return ['daemon',      ...tail];
    case 'config':      return ['config',      ...tail];
    case 'completions': return ['completions', ...tail];

    // faucet → legacy 'topup'
    case 'faucet': return ['topup', ...tail];

    // nametag subcommands: register → nametag, info → nametag-info, my → my-nametag, sync → nametag-sync
    case 'nametag': {
      const [sub, ...rest] = tail;
      if (!sub || sub === 'register') return ['nametag', ...rest];
      if (sub === 'info')  return ['nametag-info',  ...rest];
      if (sub === 'my')    return ['my-nametag',     ...rest];
      if (sub === 'sync')  return ['nametag-sync',   ...rest];
      return ['nametag', sub, ...rest];
    }

    // payments → strip namespace (send, receive, history, sync, addresses, switch, hide, unhide)
    case 'payments': return tail;

    // crypto → strip namespace (generate-key, hex-to-wif, validate-key, etc.)
    case 'crypto': return tail;

    // util → strip namespace (to-human, to-smallest, format, base58-*)
    case 'util': return tail;

    // dm: send → dm @addr msg; inbox → dm-inbox; history → dm-history
    case 'dm': {
      const [sub, ...rest] = tail;
      if (!sub) return ['dm', ...rest];
      if (sub === 'send')    return ['dm',         ...rest];
      if (sub === 'inbox')   return ['dm-inbox',   ...rest];
      if (sub === 'history') return ['dm-history', ...rest];
      return ['dm', sub, ...rest];
    }

    // group, market, swap, invoice: prefix subcommand with 'namespace-'
    case 'group':   return prefixSub('group-',   tail);
    case 'market':  return prefixSub('market-',  tail);
    case 'swap':    return prefixSub('swap-',     tail);
    case 'invoice': return prefixSub('invoice-',  tail);

    default: return [namespace, ...tail];
  }
}

function prefixSub(prefix: string, tail: string[]): string[] {
  const [sub, ...rest] = tail;
  if (!sub) return [prefix.replace(/-$/, ''), ...rest];
  return [`${prefix}${sub}`, ...rest];
}

export function createCli(): Command {
  const program = new Command();

  program
    .name('sphere')
    .description('The unified CLI for Sphere SDK and agentic-hosting control')
    .version(VERSION, '-v, --version', 'output the version number');

  // Throw CommanderError instead of calling process.exit() for --help, --version,
  // and parse errors. main() catches these and returns the right code, which is
  // essential for a CLI that is also imported from tests.
  program.exitOverride();

  // Phase 2: legacy commands — delegate to the sphere-sdk CLI dispatcher.
  for (const name of LEGACY_NAMESPACES) {
    const sub = program
      .command(name)
      .description(`${name} commands (legacy bridge — phase 2)`);

    sub.allowUnknownOption(true);
    sub.action(async () => {
      const legacyArgv = buildLegacyArgv(name);
      const { legacyMain } = await import('./legacy/legacy-cli.js');
      await legacyMain(legacyArgv);
    });
  }

  // Phase 4 stubs — DM-native commands, not yet implemented.
  for (const [name, description] of PHASE4_NAMESPACES) {
    const sub = program
      .command(name)
      .description(`${description} [phase 4]`);

    sub.allowUnknownOption(true);
    sub.action(() => {
      process.stderr.write(
        `sphere ${name}: not implemented yet (scheduled for phase 4). ` +
          `See SPHERE-CLI-EXTRACTION-PLAN.md for the migration schedule.\n`,
      );
      process.exit(64); // EX_USAGE
    });
  }

  // Phase 4 (live): `sphere host` — HMCP over Sphere DMs.
  program.addCommand(createHostCommand());

  return program;
}

/** Parse argv and execute. Returns the exit code. */
export async function main(argv: string[] = process.argv): Promise<number> {
  const program = createCli();
  try {
    await program.parseAsync(argv);
    return 0;
  } catch (err) {
    // commander throws CommanderError on --help/--version/parse errors; those are
    // handled internally (output already printed). Re-exit with the right code.
    if (err && typeof err === 'object' && 'code' in err && 'exitCode' in err) {
      const ce = err as { code: string; exitCode: number };
      if (ce.code === 'commander.helpDisplayed' || ce.code === 'commander.version') {
        return 0;
      }
      return ce.exitCode ?? 1;
    }
    // Sanitize: never echo raw error messages (may contain mnemonics or keys)
    const raw = err instanceof Error ? err.message : String(err);
    const safe = raw.replace(/\b([a-z]+\s+){11,23}[a-z]+\b/gi, '[REDACTED]');
    process.stderr.write(`sphere: ${safe}\n`);
    return 1;
  }
}

// `bin/sphere.mjs` imports this module and calls `main()` directly.
// No module-level auto-invocation (it would conflict with test imports).
