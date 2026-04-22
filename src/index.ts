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

// Legacy namespaces that delegate to the sphere-sdk CLI dispatcher.
// These are wired in phase 2 and replaced command-by-command in phase 4+.
const LEGACY_NAMESPACES = new Set([
  'wallet', 'balance', 'payments', 'dm', 'group', 'market', 'swap',
  'invoice', 'nametag', 'crypto', 'util', 'faucet', 'daemon', 'config',
  'completions',
]);

// Phase 4 namespaces — DM-native, not yet implemented.
const PHASE4_NAMESPACES: Array<[string, string]> = [
  ['host', 'HMCP: controller → host manager (over DM)'],
  ['tenant', 'ACP: controller → tenant (over DM, host-agnostic)'],
];

export function createCli(): Command {
  const program = new Command();

  program
    .name('sphere')
    .description('The unified CLI for Sphere SDK and agentic-hosting control')
    .version(VERSION, '-v, --version', 'output the version number');

  // Phase 2: legacy commands — delegate to the sphere-sdk CLI dispatcher.
  for (const name of LEGACY_NAMESPACES) {
    const sub = program
      .command(name)
      .description(`${name} commands (legacy bridge — phase 2)`);

    sub.allowUnknownOption(true);
    sub.action(async () => {
      const { legacyMain } = await import('./legacy/legacy-cli.js');
      await legacyMain();
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

  return program;
}

/** Parse argv and execute. Returns the exit code. */
export async function main(argv: string[] = process.argv): Promise<number> {
  const program = createCli();
  try {
    await program.parseAsync(argv);
    return 0;
  } catch (err) {
    process.stderr.write(
      `sphere: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

// `bin/sphere.mjs` imports this module and calls `main()` directly.
// No module-level auto-invocation (it would conflict with test imports).
