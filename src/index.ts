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
 * Phase 1 wires only the scaffold + `--version`. Real commands land in
 * phase 2 (migrate from sphere-sdk/cli/) and phase 4 (migrate from
 * agentic-hosting/src/cli/ + the new DM transport).
 */

import { Command } from 'commander';
import { VERSION } from './version.js';

export function createCli(): Command {
  const program = new Command();

  program
    .name('sphere')
    .description('The unified CLI for Sphere SDK and agentic-hosting control')
    .version(VERSION, '-v, --version', 'output the version number');

  // Namespace placeholders. Each is a real commander subcommand with a help
  // stub that tells the user "not yet — see phase N". This lets `sphere --help`
  // reflect the full topology immediately, so users know what's coming.
  const namespaces: Array<[string, string, string]> = [
    ['wallet', 'Wallet lifecycle (init, status, profiles)', 'phase 2'],
    ['balance', 'L3 token balances + asset info', 'phase 2'],
    ['payments', 'Send, receive, history', 'phase 2'],
    ['dm', 'Direct messages (NIP-17) — send, inbox, history', 'phase 2'],
    ['group', 'Group chat (NIP-29)', 'phase 2'],
    ['market', 'Post and search trading intents', 'phase 2'],
    ['swap', 'P2P atomic swap lifecycle', 'phase 2'],
    ['invoice', 'Invoicing + accounting', 'phase 2'],
    ['nametag', 'Register and look up nametags', 'phase 2'],
    ['crypto', 'Key / wallet utility commands', 'phase 2'],
    ['util', 'Amount conversion, base58 codec', 'phase 2'],
    ['faucet', 'Testnet token faucet', 'phase 2'],
    ['daemon', 'Long-running event listener', 'phase 2'],
    ['host', 'HMCP: controller → host manager (over DM)', 'phase 4'],
    ['tenant', 'ACP: controller → tenant (over DM, host-agnostic)', 'phase 4'],
    ['config', 'CLI configuration (profiles, relays, manager)', 'phase 1+'],
    ['completions', 'Shell completion scripts', 'phase 2'],
  ];

  for (const [name, description, phase] of namespaces) {
    const sub = program
      .command(name)
      .description(`${description} [${phase}]`);

    // Catch-all action so `sphere wallet init` (with args) prints a helpful
    // message until the real command lands. Subcommands within each namespace
    // come in later phases.
    sub.allowUnknownOption(true);
    sub.action(() => {
      process.stderr.write(
        `sphere ${name}: not implemented yet (scheduled for ${phase}). ` +
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
