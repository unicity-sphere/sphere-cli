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
import { spawnTrader, stopTrader, type TraderSpawnOptions, type TraderStopOptions } from './spawn.js';

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
  volumeMax: string;
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

interface TraderSpawnCliOpts {
  name?: string;
  trustedEscrows?: string;
  scanIntervalMs?: string;
  testFund?: string;
  readyTimeoutMs?: string;
  baseDir?: string;
  hmImage?: string;
  templatesFile?: string;
  healthPort?: string;
  image?: string;
  network?: 'testnet' | 'mainnet' | 'dev';
}

interface TraderStopCliOpts {
  name?: string;
  keepHm?: boolean;
  baseDir?: string;
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

/**
 * Build the wire payload for CREATE_INTENT from CLI options. Pure
 * function so it's unit-testable without a Sphere/DM stack.
 *
 * Returns `{ params }` on success or `{ error }` with a human-
 * readable message the caller can write to stderr. Validation here
 * mirrors the trader-side ACP validation
 * (trader-service/src/trader/trader-command-handler.ts:331-342) so
 * the operator gets a clear diagnostic at the CLI layer instead of
 * an opaque INVALID_PARAM from a remote service.
 */
export function buildCreateIntentParams(
  opts: CreateIntentOpts,
): { readonly params: Record<string, unknown> } | { readonly error: string } {
  if (opts.direction !== 'buy' && opts.direction !== 'sell') {
    return { error: '--direction must be "buy" or "sell"' };
  }
  const params: Record<string, unknown> = {
    direction: opts.direction,
    base_asset: opts.base,
    quote_asset: opts.quote,
    rate_min: opts.rateMin,
    rate_max: opts.rateMax,
    volume_min: opts.volumeMin,
    volume_max: opts.volumeMax,
  };
  if (opts.expiryMs !== undefined) {
    const n = Number.parseInt(opts.expiryMs, 10);
    if (!Number.isFinite(n) || n <= 0) {
      return { error: `--expiry-ms must be a positive integer (got "${opts.expiryMs}")` };
    }
    // Trader's ACP CREATE_INTENT param is `expiry_sec` (validated
    // as a finite positive integer ≤ 7 days). The CLI flag stays
    // in milliseconds for ergonomic consistency with other timeout
    // flags; we convert at the wire boundary via floor(ms/1000).
    if (n < 1000) {
      // Sub-second expiries make no sense for trade intents and
      // floor(ms/1000) would map them to 0, which the trader
      // rejects with an unhelpful INVALID_PARAM. Catch here.
      return { error: `--expiry-ms must be at least 1000 (1 second); got ${n}` };
    }
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    if (n > sevenDaysMs) {
      // 7-day cap matches the trader's own validation. Catch it
      // here too so the operator gets the right diagnostic without
      // a network round-trip.
      return { error: `--expiry-ms must not exceed 7 days (${sevenDaysMs}ms); got ${n}` };
    }
    params['expiry_sec'] = Math.floor(n / 1000);
  }
  return { params };
}

async function handleCreateIntent(cmd: Command, opts: CreateIntentOpts): Promise<void> {
  await runWithTransport(cmd, async ({ transport, json }) => {
    const built = buildCreateIntentParams(opts);
    if ('error' in built) {
      writeStderr(built.error);
      process.exitCode = 1;
      return;
    }
    const response = await transport.sendCommand('CREATE_INTENT', built.params);
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

// `sphere trader status` was previously wired to send STATUS over ACP
// directly to the trader. STATUS is a SYSTEM-scoped command per the
// Unicity architecture (system commands like STATUS, SHUTDOWN_GRACEFUL,
// SET_LOG_LEVEL, EXEC route through the tenant's host manager via HMCP,
// not direct controller→tenant ACP). The trader correctly rejects
// direct STATUS calls with UNAUTHORIZED. The subcommand has been
// removed from the CLI tree below; controllers should use
// `sphere host inspect <instance>` (HMCP) to probe trader liveness, or
// rely on `sphere trader portfolio`/`list-intents` succeeding as an
// implicit liveness signal.

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
// Local tenant lifecycle (`sphere trader spawn` / `sphere trader stop`)
// =============================================================================
//
// These don't speak ACP to a running trader. They bring up (or tear down)
// the per-user local HM + trader tenant pair. See trader/spawn.ts for the
// orchestration; this layer just adapts commander options.

/**
 * Parse a positive integer from a CLI flag value. Returns the number on
 * success, throws on invalid input. Shared shape used by --scan-interval-ms
 * / --ready-timeout-ms / --health-port.
 *
 * Exported for unit tests.
 */
export function parsePositiveInt(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid ${flag}: ${raw} (must be a positive integer)`);
  }
  return n;
}

/**
 * Translate commander `--trusted-escrows '@a,@b'` into the array
 * `trader/spawn.ts` consumes. Empty / whitespace-only entries are
 * filtered out so a trailing comma doesn't become a phantom escrow.
 *
 * Exported for unit tests.
 */
export function parseTrustedEscrows(raw: string | undefined): ReadonlyArray<string> | undefined {
  if (raw === undefined) return undefined;
  const items = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

/**
 * Map CLI spawn options to the `TraderSpawnOptions` shape. Pure —
 * the unit tests cover the wallet-nametag → instance-name fallback
 * and the option-passthrough.
 *
 * Exported for unit tests.
 */
export function buildSpawnOptions(opts: TraderSpawnCliOpts): TraderSpawnOptions {
  const out: Record<string, unknown> = {};
  if (opts.name) out['name'] = opts.name;
  const escrows = parseTrustedEscrows(opts.trustedEscrows);
  if (escrows) out['trustedEscrows'] = escrows;
  const scan = parsePositiveInt(opts.scanIntervalMs, '--scan-interval-ms');
  if (scan !== undefined) out['scanIntervalMs'] = scan;
  if (opts.testFund) out['testFund'] = opts.testFund;
  const ready = parsePositiveInt(opts.readyTimeoutMs, '--ready-timeout-ms');
  if (ready !== undefined) out['readyTimeoutMs'] = ready;
  if (opts.baseDir) out['baseDir'] = opts.baseDir;
  if (opts.hmImage) out['hmImage'] = opts.hmImage;
  if (opts.templatesFile) out['templatesFile'] = opts.templatesFile;
  const health = parsePositiveInt(opts.healthPort, '--health-port');
  if (health !== undefined) out['healthPort'] = health;
  if (opts.image) out['image'] = opts.image;
  if (opts.network) out['network'] = opts.network;
  return out as TraderSpawnOptions;
}

async function handleSpawn(cmd: Command, opts: TraderSpawnCliOpts): Promise<void> {
  const globals = parseGlobalOpts(cmd);
  const json = globals.json ?? false;
  let spawnOpts: TraderSpawnOptions;
  try {
    spawnOpts = buildSpawnOptions(opts);
  } catch (err) {
    writeStderr((err as Error).message);
    process.exitCode = 1;
    return;
  }
  try {
    const result = await spawnTrader(spawnOpts);
    if (json) {
      printJson(result);
    } else {
      process.stdout.write(
        `Trader tenant ready:\n` +
        `  instance_name:           ${result.instance_name}\n` +
        `  instance_id:             ${result.instance_id}\n` +
        `  tenant_direct_address:   ${result.tenant_direct_address}\n` +
        `  tenant_nametag:          ${result.tenant_nametag ?? '(none)'}\n` +
        `  hm_container:            ${result.hm_container}\n` +
        `  hm_manager_address:      ${result.hm_manager_address}\n\n` +
        `Use this address for subsequent ACP calls:\n` +
        `  export SPHERE_TRADER_TENANT='${result.tenant_direct_address}'\n` +
        `  sphere trader create-intent --direction sell --base UCT --quote USDU \\\n` +
        `      --rate-min 1 --rate-max 1 --volume-min 1 --volume-max 100\n`,
      );
    }
  } catch (err) {
    writeStderr((err as Error).message);
    process.exitCode = 1;
  }
}

async function handleStop(cmd: Command, opts: TraderStopCliOpts): Promise<void> {
  const globals = parseGlobalOpts(cmd);
  const json = globals.json ?? false;
  const stopOpts: TraderStopOptions = {};
  const out = stopOpts as { name?: string; keepHm?: boolean; baseDir?: string };
  if (opts.name)    out.name    = opts.name;
  if (opts.keepHm)  out.keepHm  = true;
  if (opts.baseDir) out.baseDir = opts.baseDir;
  try {
    const result = await stopTrader(stopOpts);
    if (json) {
      printJson(result);
    } else {
      if (result.tenant_stopped) {
        process.stdout.write(`Trader tenant stopped: ${result.tenant_name ?? '(unknown)'}\n`);
      } else if (result.tenant_name) {
        process.stdout.write(`No live trader tenant '${result.tenant_name}' found.\n`);
      } else {
        process.stdout.write('No local HM running for this wallet.\n');
      }
      if (result.hm_stopped) {
        process.stdout.write(
          result.hm_removed
            ? 'Local HM stopped and removed.\n'
            : 'Local HM stopped (container kept).\n',
        );
      } else if (opts.keepHm) {
        process.stdout.write('Local HM left running (--keep-hm).\n');
      }
    }
  } catch (err) {
    writeStderr((err as Error).message);
    process.exitCode = 1;
  }
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
    .requiredOption('--volume-max <bigint>', 'Total intent volume')
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

  // `status` removed — STATUS is system-scoped and routes through the
  // host manager. See the comment on the deleted handleStatus above.
  // Use `sphere host inspect <instance>` for trader liveness probes.

  trader
    .command('set-strategy')
    .description("Update the trader's strategy parameters")
    .option('--rate-strategy <strategy>', 'Rate strategy: aggressive|moderate|conservative')
    .option('--max-concurrent <n>', 'Max concurrent negotiations')
    .option('--trusted-escrows <list>', 'Comma-separated escrow addresses (overwrites)')
    .action(async function (this: Command, opts: SetStrategyOpts) {
      await handleSetStrategy(this, opts);
    });

  // ── Local tenant lifecycle (per-user HM + trader) ─────────────────
  // `sphere trader spawn` and `sphere trader stop` don't talk to a
  // running trader (no --tenant flag) — they bring up / tear down the
  // per-user local HM + trader tenant pair. See sphere-cli#48 for the
  // motivation.

  trader
    .command('spawn')
    .description('Bring up a local trader tenant (and its HM) for the current wallet')
    .option('--name <instance>', 'Tenant instance name (default: <wallet-nametag>-trader)')
    .option('--trusted-escrows <list>', 'Comma-separated escrow addresses for the trader')
    .option('--scan-interval-ms <ms>', 'Override TRADER_SCAN_INTERVAL_MS (default: 30000)')
    .option('--test-fund <spec>', 'Self-mint test funds at startup, e.g. "<coinIdHex>:<amount>,..." (testnet only)')
    .option('--ready-timeout-ms <ms>', 'Wait up to this long for HM + tenant ready (default: 180000)')
    .option('--base-dir <path>', 'Override per-controller data dir (default: ./.sphere-cli/local-hm)')
    .option('--hm-image <ref>', 'Override the local HM container image')
    .option('--templates-file <path>', 'Override templates.json mounted into the HM')
    .option('--health-port <port>', 'Override HM health-port host mapping (127.0.0.1:<port>)')
    .option('--network <name>', 'Sphere network: testnet|mainnet|dev (default: testnet)')
    .action(async function (this: Command, opts: TraderSpawnCliOpts) {
      await handleSpawn(this, opts);
    });

  trader
    .command('stop')
    .description('Stop the local trader tenant (and the HM if no other tenants remain)')
    .option('--name <instance>', 'Tenant instance name to stop (default: <wallet-nametag>-trader)')
    .option('--keep-hm', 'Leave the local HM container running after stopping the tenant')
    .option('--base-dir <path>', 'Override per-controller data dir (default: ./.sphere-cli/local-hm)')
    .action(async function (this: Command, opts: TraderStopCliOpts) {
      await handleStop(this, opts);
    });

  // Attach the shared-options help text to every subcommand.
  for (const sub of trader.commands) {
    sub.addHelpText('after', `\n${inheritedHelp}`);
  }

  return trader;
}

// Exported for unit tests.
export { parseTimeout };
// `buildCreateIntentParams` is also exported via its `export function`
// declaration above; named here for discoverability alongside parseTimeout.
