/**
 * `sphere trader` Commander subcommand tree — ACP-0 client over Sphere DMs.
 *
 * Talks DIRECTLY to a running trader tenant (the host manager is NOT in the
 * loop). The tenant's AcpListener authenticates the sender against either
 * UNICITY_MANAGER_PUBKEY or UNICITY_CONTROLLER_PUBKEY; the operator running
 * `sphere trader` does so under the wallet identity that matches one of those.
 *
 * Mirrors the canonical `trader-ctl` from vrogojin/trader-service (which owns
 * the command surface). Operators with the canonical tool installed can use
 * either; `sphere trader` ships in sphere-cli for convenience parity with
 * `sphere host`.
 */

import { Command } from 'commander';
import type { Sphere } from '@unicitylabs/sphere-sdk';

import { initSphere } from '../host/sphere-init.js';
import { createAcpDmTransport } from './acp-transport.js';
import type { AcpDmTransport } from './acp-transport.js';
import type { AcpResultPayload, AcpErrorPayload } from './acp-protocols.js';
import { TimeoutError, TransportError } from '../transport/errors.js';
import { MIN_TIMEOUT_MS } from '../shared/timeout-constants.js';

const DEFAULT_TIMEOUT_MS = 30_000;

// =============================================================================
// Option types
// =============================================================================

interface GlobalOpts {
  tenant?: string;
  json?: boolean;
  timeout?: string;
}

interface CreateIntentOpts {
  direction: string;
  base: string;
  quote: string;
  rateMin: string;
  rateMax: string;
  volumeMin: string;
  volumeTotal: string;
  expiryMs?: string;
}

interface CancelIntentOpts {
  intentId: string;
}

interface ListIntentsOpts {
  state?: string;
  limit?: string;
}

interface ListDealsOpts {
  state?: string;
  limit?: string;
}

interface SetStrategyOpts {
  rateStrategy?: string;
  maxConcurrent?: string;
  trustedEscrows?: string;
}

// =============================================================================
// Helpers
// =============================================================================

function parseGlobalOpts(cmd: Command): GlobalOpts {
  // optsWithGlobals walks the parent chain — same pattern used in host-commands.
  return cmd.optsWithGlobals<GlobalOpts>();
}

/**
 * Reject sub-floor timeouts at the CLI surface so the operator gets a clear
 * local error, not a confusing two-hop `invalid_params` from the tenant.
 * Aligned with agentic-hosting's MIN_TIMEOUT_MS via shared/timeout-constants.
 */
function parseTimeout(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid timeout: ${raw}`);
  }
  const floored = Math.floor(n);
  if (floored < MIN_TIMEOUT_MS) {
    throw new Error(
      `Invalid timeout: ${raw} (minimum ${MIN_TIMEOUT_MS}ms — values below this are rejected by the tenant dispatcher)`,
    );
  }
  return floored;
}

export function resolveTenantAddress(opts: { tenant?: string }): string {
  const address = opts.tenant ?? process.env['SPHERE_TRADER_TENANT'];
  if (!address || address.trim() === '') {
    throw new Error(
      'No trader tenant address. Pass --tenant <@nametag|DIRECT://hex|hex> or set SPHERE_TRADER_TENANT.',
    );
  }
  return address.trim();
}

function writeStderr(msg: unknown): void {
  const s = typeof msg === 'string' ? msg : String(msg ?? 'unknown error');
  const prefixed = s.startsWith('sphere trader:') || s.startsWith('sphere:')
    ? s
    : `sphere trader: ${s}`;
  process.stderr.write(prefixed.endsWith('\n') ? prefixed : `${prefixed}\n`);
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

// =============================================================================
// Core runner
// =============================================================================

interface RunContext {
  sphere: Sphere;
  transport: AcpDmTransport;
  timeoutMs: number;
  json: boolean;
}

type Handler = (ctx: RunContext) => Promise<void>;

async function runWithTransport(cmd: Command, handler: Handler): Promise<void> {
  const globals = parseGlobalOpts(cmd);
  const json = globals.json ?? false;

  let timeoutMs: number;
  let tenantAddress: string;
  try {
    timeoutMs = parseTimeout(globals.timeout, DEFAULT_TIMEOUT_MS);
    tenantAddress = resolveTenantAddress({ tenant: globals.tenant });
  } catch (err) {
    writeStderr((err as Error).message);
    process.exitCode = 1;
    return;
  }

  let sphere: Sphere | null = null;
  let transport: AcpDmTransport | null = null;
  try {
    sphere = await initSphere();
    transport = createAcpDmTransport(sphere.communications, {
      tenantAddress,
      timeoutMs,
      // Cosmetic — appears in tenant logs to identify the controller's
      // session. Could be made configurable; sphere-cli is fine for now.
      instanceId: process.env['UNICITY_INSTANCE_ID'] ?? 'sphere-cli',
      instanceName: process.env['UNICITY_INSTANCE_NAME'] ?? 'sphere-cli',
    });
    await handler({ sphere, transport, timeoutMs, json });
  } catch (err) {
    handleError(err, json);
  } finally {
    if (transport) {
      try { await transport.dispose(); } catch (e) {
        if (process.env['DEBUG']) writeStderr(`sphere-cli: transport.dispose error: ${e}`);
      }
    }
    if (sphere) {
      try { await sphere.destroy(); } catch (e) {
        if (process.env['DEBUG']) writeStderr(`sphere-cli: sphere.destroy error: ${e}`);
      }
    }
  }
}

function handleError(err: unknown, json: boolean): void {
  if (err instanceof TimeoutError) {
    writeStderr('Request timed out');
  } else if (err instanceof TransportError) {
    writeStderr(err.message);
  } else if (err instanceof Error) {
    writeStderr(err.message);
  } else {
    writeStderr(String(err));
  }
  void json;
  process.exitCode = 1;
}

function emitResult(json: boolean, response: AcpResultPayload | AcpErrorPayload): void {
  if (json) {
    printJson(response);
  } else if (response.ok === false) {
    writeStderr(`[${response.error_code}] ${response.message}`);
  } else {
    printJson(response.result);
  }
  if (response.ok === false) {
    process.exitCode = 1;
  }
}

// =============================================================================
// Subcommand handlers
// =============================================================================

async function handleCreateIntent(cmd: Command, opts: CreateIntentOpts): Promise<void> {
  await runWithTransport(cmd, async ({ transport, json }) => {
    if (opts.direction !== 'buy' && opts.direction !== 'sell') {
      writeStderr('--direction must be "buy" or "sell"');
      process.exitCode = 1;
      return;
    }
    const params: Record<string, unknown> = {
      direction: opts.direction,
      base_asset: opts.base,
      quote_asset: opts.quote,
      rate_min: opts.rateMin,
      rate_max: opts.rateMax,
      volume_min: opts.volumeMin,
      volume_total: opts.volumeTotal,
    };
    if (opts.expiryMs !== undefined) {
      const n = Number.parseInt(opts.expiryMs, 10);
      if (!Number.isFinite(n) || n <= 0) {
        writeStderr(`--expiry-ms must be a positive integer (got "${opts.expiryMs}")`);
        process.exitCode = 1;
        return;
      }
      params['expiry_ms'] = n;
    }
    const response = await transport.sendCommand('CREATE_INTENT', params);
    emitResult(json, response);
  });
}

async function handleCancelIntent(cmd: Command, opts: CancelIntentOpts): Promise<void> {
  await runWithTransport(cmd, async ({ transport, json }) => {
    const response = await transport.sendCommand('CANCEL_INTENT', { intent_id: opts.intentId });
    emitResult(json, response);
  });
}

async function handleListIntents(cmd: Command, opts: ListIntentsOpts): Promise<void> {
  await runWithTransport(cmd, async ({ transport, json }) => {
    const params: Record<string, unknown> = {};
    if (opts.state !== undefined) params['state'] = opts.state;
    if (opts.limit !== undefined) {
      const n = Number.parseInt(opts.limit, 10);
      if (!Number.isFinite(n) || n <= 0) {
        writeStderr(`--limit must be a positive integer (got "${opts.limit}")`);
        process.exitCode = 1;
        return;
      }
      params['limit'] = n;
    }
    const response = await transport.sendCommand('LIST_INTENTS', params);
    emitResult(json, response);
  });
}

async function handleListDeals(cmd: Command, opts: ListDealsOpts): Promise<void> {
  await runWithTransport(cmd, async ({ transport, json }) => {
    const params: Record<string, unknown> = {};
    if (opts.state !== undefined) params['state'] = opts.state;
    if (opts.limit !== undefined) {
      const n = Number.parseInt(opts.limit, 10);
      if (!Number.isFinite(n) || n <= 0) {
        writeStderr(`--limit must be a positive integer (got "${opts.limit}")`);
        process.exitCode = 1;
        return;
      }
      params['limit'] = n;
    }
    // Trader exposes the swap-set via LIST_SWAPS; alias it as `list-deals`
    // because operators think in deal language. Spec also accepts LIST_SWAPS
    // — keep the wire name canonical.
    const response = await transport.sendCommand('LIST_SWAPS', params);
    emitResult(json, response);
  });
}

async function handlePortfolio(cmd: Command): Promise<void> {
  await runWithTransport(cmd, async ({ transport, json }) => {
    const response = await transport.sendCommand('GET_PORTFOLIO', {});
    emitResult(json, response);
  });
}

async function handleStatus(cmd: Command): Promise<void> {
  await runWithTransport(cmd, async ({ transport, json }) => {
    const response = await transport.sendCommand('STATUS', {});
    emitResult(json, response);
  });
}

async function handleSetStrategy(cmd: Command, opts: SetStrategyOpts): Promise<void> {
  await runWithTransport(cmd, async ({ transport, json }) => {
    const params: Record<string, unknown> = {};
    if (opts.rateStrategy !== undefined) params['rate_strategy'] = opts.rateStrategy;
    if (opts.maxConcurrent !== undefined) {
      const n = Number.parseInt(opts.maxConcurrent, 10);
      if (!Number.isFinite(n) || n <= 0) {
        writeStderr(`--max-concurrent must be a positive integer (got "${opts.maxConcurrent}")`);
        process.exitCode = 1;
        return;
      }
      params['max_concurrent_negotiations'] = n;
    }
    if (opts.trustedEscrows !== undefined) {
      params['trusted_escrows'] = opts.trustedEscrows.split(',').map((s) => s.trim()).filter((s) => s !== '');
    }
    if (Object.keys(params).length === 0) {
      writeStderr('set-strategy: at least one of --rate-strategy / --max-concurrent / --trusted-escrows must be provided');
      process.exitCode = 1;
      return;
    }
    const response = await transport.sendCommand('SET_STRATEGY', params);
    emitResult(json, response);
  });
}

// =============================================================================
// Command tree
// =============================================================================

export function createTraderCommand(): Command {
  const trader = new Command('trader')
    .description('ACP: controller → trader tenant (over Sphere DM)')
    .option('--tenant <address>', 'Trader tenant address (@nametag, DIRECT://hex, or hex pubkey)')
    .option('--json', 'Output raw JSON response')
    .option('--timeout <ms>', 'Override default request timeout (ms)', String(DEFAULT_TIMEOUT_MS));

  const inheritedHelp =
    'Inherited options:\n' +
    '  --tenant <address>   Trader tenant address (@nametag, DIRECT://hex, or hex pubkey)\n' +
    '  --json               Output raw JSON response\n' +
    '  --timeout <ms>       Override default request timeout (ms)';

  trader
    .command('create-intent')
    .description('Submit a new trading intent to the trader')
    .requiredOption('--direction <buy|sell>', 'Trade direction')
    .requiredOption('--base <asset>', 'Base asset (e.g. UCT)')
    .requiredOption('--quote <asset>', 'Quote asset (e.g. USDC)')
    .requiredOption('--rate-min <bigint>', 'Minimum acceptable rate (string-encoded bigint)')
    .requiredOption('--rate-max <bigint>', 'Maximum acceptable rate (string-encoded bigint)')
    .requiredOption('--volume-min <bigint>', 'Minimum volume per match')
    .requiredOption('--volume-total <bigint>', 'Total intent volume')
    .option('--expiry-ms <ms>', 'Expiry duration in milliseconds (default: 24h)')
    .action(async function (this: Command, opts: CreateIntentOpts) {
      await handleCreateIntent(this, opts);
    });

  trader
    .command('cancel-intent')
    .description('Cancel an active intent by ID')
    .requiredOption('--intent-id <id>', 'Intent ID to cancel')
    .action(async function (this: Command, opts: CancelIntentOpts) {
      await handleCancelIntent(this, opts);
    });

  trader
    .command('list-intents')
    .description("List the trader's active and recent intents")
    .option('--state <state>', 'Filter by state: active|filled|cancelled|expired')
    .option('--limit <n>', 'Maximum number of intents to return')
    .action(async function (this: Command, opts: ListIntentsOpts) {
      await handleListIntents(this, opts);
    });

  trader
    .command('list-deals')
    .description('List active and completed deals (a.k.a. swaps)')
    .option('--state <state>', 'Filter by state: active|completed|failed')
    .option('--limit <n>', 'Maximum number of deals to return')
    .action(async function (this: Command, opts: ListDealsOpts) {
      await handleListDeals(this, opts);
    });

  trader
    .command('portfolio')
    .description("Show the trader's current asset balances")
    .action(async function (this: Command) {
      await handlePortfolio(this);
    });

  trader
    .command('status')
    .description('Show STATUS — uptime + adapter info')
    .action(async function (this: Command) {
      await handleStatus(this);
    });

  trader
    .command('set-strategy')
    .description("Update the trader's strategy parameters")
    .option('--rate-strategy <strategy>', 'Rate strategy: aggressive|moderate|conservative')
    .option('--max-concurrent <n>', 'Max concurrent negotiations')
    .option('--trusted-escrows <list>', 'Comma-separated escrow addresses (overwrites)')
    .action(async function (this: Command, opts: SetStrategyOpts) {
      await handleSetStrategy(this, opts);
    });

  // Attach the shared-options help text to every subcommand.
  for (const sub of trader.commands) {
    sub.addHelpText('after', `\n${inheritedHelp}`);
  }

  return trader;
}

// Exported for unit tests.
export { parseTimeout };
