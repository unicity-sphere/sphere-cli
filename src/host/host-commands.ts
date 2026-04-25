/**
 * `sphere host` Commander subcommand tree — HMCP-0 client over Sphere DMs.
 */

import { Command, Option } from 'commander';
import type { Sphere } from '@unicitylabs/sphere-sdk';
import { createDmTransport } from '../transport/dm-transport.js';
import { createHmcpRequest } from '../transport/hmcp-types.js';
import { TimeoutError, TransportError } from '../transport/errors.js';
import type { DmTransport } from '../transport/dm-transport.js';
import type {
  HmcpRequest,
  HmcpRequestType,
  HmcpResponse,
  HmCommandPayload,
  HmCommandResultPayload,
  HmErrorPayload,
  HmHelpResultPayload,
  HmInspectResultPayload,
  HmInstanceSummary,
  HmListResultPayload,
  HmSpawnAckPayload,
  HmSpawnFailedPayload,
  HmSpawnReadyPayload,
  HmStartAckPayload,
  HmStartFailedPayload,
  HmStartReadyPayload,
  HmStopResultPayload,
} from '../transport/hmcp-types.js';
import { hasDangerousKeys } from '../transport/hmcp-types.js';
import { initSphere, resolveManagerAddress } from './sphere-init.js';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Transport-layer timeout headroom past a caller-supplied per-command
 * timeout. The tenant's command handler honours `--cmd-timeout`; we need
 * the transport to wait at least that long PLUS round-trip for the reply
 * to travel back. 10 s covers relay RTT under typical public-relay load.
 */
const TRANSPORT_HEADROOM_MS = 10_000;

// =============================================================================
// Option types
// =============================================================================

interface GlobalOpts {
  manager?: string;
  json?: boolean;
  timeout?: string;
}

interface NameOrIdOpts {
  id?: boolean;
}

interface SpawnOpts {
  template: string;
  nametag?: string;
  env?: string[];
}

interface ListOpts {
  state?: string;
}

interface CmdOpts extends NameOrIdOpts {
  params?: string;
  cmdTimeout?: string;
}

// =============================================================================
// Helpers
// =============================================================================

function parseGlobalOpts(cmd: Command): GlobalOpts {
  // Commander 12's optsWithGlobals() walks the parent chain and merges
  // — replaces an earlier hand-rolled walker. Kept as a named helper so
  // call sites still read well and we have a single swap point for
  // future option additions.
  return cmd.optsWithGlobals<GlobalOpts>();
}

// Floor used by tenant-side hm.command dispatcher (agentic-hosting
// command-registry.ts MIN_TIMEOUT_MS). Pre-flighting at the CLI surface
// avoids the confusing two-hop error path: CLI → manager → tenant rejects
// with `invalid_params`. Keep aligned with agentic-hosting's constant.
const MIN_TIMEOUT_MS = 100;

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

function parseEnvPairs(pairs: readonly string[] | undefined): Record<string, string> | undefined {
  if (!pairs || pairs.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const raw of pairs) {
    const eq = raw.indexOf('=');
    if (eq <= 0) {
      throw new Error(`Invalid --env value "${raw}" (expected KEY=VALUE).`);
    }
    const key = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1);
    if (!key) {
      throw new Error(`Invalid --env value "${raw}" (empty key).`);
    }
    out[key] = value;
  }
  return out;
}

function parseJsonParams(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid --params JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('--params must be a JSON object.');
  }
  if (hasDangerousKeys(parsed)) {
    throw new Error('--params contains forbidden keys (__proto__, constructor, prototype).');
  }
  return parsed as Record<string, unknown>;
}

function targetPayload(nameOrId: string, opts: NameOrIdOpts): Record<string, unknown> {
  return opts.id ? { instance_id: nameOrId } : { instance_name: nameOrId };
}

function isErrorResponse(res: HmcpResponse): boolean {
  return res.type === 'hm.error';
}

function errorPayload(res: HmcpResponse): HmErrorPayload {
  return res.payload as unknown as HmErrorPayload;
}

// =============================================================================
// Per-type payload guards
// =============================================================================
//
// The HMCP envelope is validated by isValidHmcpResponse (hmcp-types.ts), but
// the payload shape is not — a misbehaving manager could send any fields. The
// guards below do a minimal structural check before the handler reads fields,
// so a protocol drift produces a clear error instead of "undefined" surfacing
// in a printed string. They intentionally check only the fields the handler
// uses, not every documented field.

function isHmSpawnAckPayload(p: unknown): p is HmSpawnAckPayload {
  return isPlainObject(p)
    && typeof p['instance_id'] === 'string'
    && typeof p['state'] === 'string';
}
function isHmSpawnReadyPayload(p: unknown): p is HmSpawnReadyPayload {
  return isPlainObject(p)
    && typeof p['tenant_direct_address'] === 'string';
}
function isHmSpawnFailedPayload(p: unknown): p is HmSpawnFailedPayload {
  return isPlainObject(p) && typeof p['reason'] === 'string';
}
function isHmStartAckPayload(p: unknown): p is HmStartAckPayload {
  return isHmSpawnAckPayload(p) as unknown as boolean;
}
function isHmStartReadyPayload(p: unknown): p is HmStartReadyPayload {
  return isHmSpawnReadyPayload(p) as unknown as boolean;
}
function isHmStartFailedPayload(p: unknown): p is HmStartFailedPayload {
  return isHmSpawnFailedPayload(p) as unknown as boolean;
}
function isHmStopResultPayload(p: unknown): p is HmStopResultPayload {
  return isPlainObject(p)
    && typeof p['instance_name'] === 'string'
    && typeof p['instance_id'] === 'string';
}
function isHmInspectResultPayload(p: unknown): p is HmInspectResultPayload {
  return isPlainObject(p) && typeof p['instance_id'] === 'string';
}
function isHmListResultPayload(p: unknown): p is HmListResultPayload {
  return isPlainObject(p) && Array.isArray(p['instances']);
}
function isHmHelpResultPayload(p: unknown): p is HmHelpResultPayload {
  return isPlainObject(p)
    && Array.isArray(p['commands'])
    && typeof p['version'] === 'string';
}
function isHmCommandResultPayload(p: unknown): p is HmCommandResultPayload {
  return isPlainObject(p) && p['result'] !== undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Emit a "manager sent a malformed payload" error. Sets exitCode=1. */
function onProtocolError(type: string, json: boolean): void {
  if (json) {
    writeStderr(`Protocol error: received ${type} with malformed payload`);
  } else {
    writeStderr(`sphere host: manager returned malformed ${type} payload`);
  }
  process.exitCode = 1;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Write an error line to stderr with a consistent `sphere host: ` prefix.
 * Callers pass the bare message; this helper owns the formatting so user-
 * facing output is uniform across every failure path (transport error,
 * timeout, protocol error, hm.error response, parse failure, etc.).
 */
function writeStderr(msg: unknown): void {
  const s = typeof msg === 'string' ? msg : String(msg ?? 'unknown error');
  const prefixed = s.startsWith('sphere host:') || s.startsWith('sphere:')
    ? s
    : `sphere host: ${s}`;
  process.stderr.write(prefixed.endsWith('\n') ? prefixed : `${prefixed}\n`);
}

// =============================================================================
// Core runner
// =============================================================================

interface RunContext {
  sphere: Sphere;
  transport: DmTransport;
  timeoutMs: number;
  json: boolean;
}

type Handler = (ctx: RunContext) => Promise<void>;

async function runWithTransport(cmd: Command, handler: Handler): Promise<void> {
  const globals = parseGlobalOpts(cmd);
  const json = globals.json ?? false;

  let timeoutMs: number;
  let managerAddress: string;
  try {
    timeoutMs = parseTimeout(globals.timeout, DEFAULT_TIMEOUT_MS);
    managerAddress = resolveManagerAddress({ manager: globals.manager });
  } catch (err) {
    writeStderr((err as Error).message);
    process.exitCode = 1;
    return;
  }

  let sphere: Sphere | null = null;
  let transport: DmTransport | null = null;
  try {
    sphere = await initSphere();
    transport = createDmTransport(sphere.communications, { managerAddress, timeoutMs });
    await handler({ sphere, transport, timeoutMs, json });
  } catch (err) {
    handleError(err, json);
  } finally {
    // transport must be disposed before sphere.destroy so communications
    // unsubscribe works while the transport layer is still live.
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
  // json flag does not change error channel — errors always go to stderr as plain text.
  void json;
  process.exitCode = 1;
}

function handleHmError(res: HmcpResponse, json: boolean): void {
  if (json) {
    printJson(res);
  } else {
    writeStderr(errorPayload(res).message);
  }
  process.exitCode = 1;
}

// =============================================================================
// Streaming lifecycle helper (spawn / start / resume)
// =============================================================================
//
// spawn, start and resume share the same shape: send request → stream of ack
// + (ready | failed | error) → terminal response. Originally each handler
// rebuilt the collection + iteration loop; this helper gives one correct
// implementation and lets each caller plug in its own human-readable
// formatters for ack/ready/failed.

interface StreamingLifecycleHandlers {
  readonly ackType: string;
  readonly readyTypes: readonly string[];
  readonly failedType: string;
  readonly formatAck: (res: HmcpResponse) => void;
  readonly formatReady: (res: HmcpResponse) => void;
  readonly formatFailed: (res: HmcpResponse) => void;
}

async function runStreamingLifecycle(
  cmd: Command,
  type: HmcpRequestType,
  payload: Record<string, unknown>,
  h: StreamingLifecycleHandlers,
): Promise<void> {
  await runWithTransport(cmd, async ({ transport, json }) => {
    const req = createHmcpRequest(type, payload);

    const collected: HmcpResponse[] = [];
    await transport.sendRequestStream(req, (res) => {
      collected.push(res);
      return (
        h.readyTypes.includes(res.type) ||
        res.type === h.failedType ||
        res.type === 'hm.error'
      );
    });

    if (json) {
      printJson(collected);
      const last = collected[collected.length - 1];
      if (last && (last.type === h.failedType || last.type === 'hm.error')) {
        process.exitCode = 1;
      }
      return;
    }

    for (const res of collected) {
      if (res.type === h.ackType) {
        h.formatAck(res);
      } else if (h.readyTypes.includes(res.type)) {
        h.formatReady(res);
      } else if (res.type === h.failedType) {
        h.formatFailed(res);
        process.exitCode = 1;
      } else if (isErrorResponse(res)) {
        handleHmError(res, json);
      }
    }
  });
}

// =============================================================================
// Subcommand handlers
// =============================================================================

async function handleSpawn(cmd: Command, name: string, sOpts: SpawnOpts): Promise<void> {
  const env = parseEnvPairs(sOpts.env);
  const payload: Record<string, unknown> = {
    template_id: sOpts.template,
    instance_name: name,
  };
  if (sOpts.nametag) payload['nametag'] = sOpts.nametag;
  if (env) payload['env'] = env;

  await runStreamingLifecycle(cmd, 'hm.spawn', payload, {
    ackType: 'hm.spawn_ack',
    readyTypes: ['hm.spawn_ready'],
    failedType: 'hm.spawn_failed',
    formatAck: (res) => {
      if (!isHmSpawnAckPayload(res.payload)) return onProtocolError(res.type, false);
      writeStderr(`Accepted: ${res.payload.instance_id} (${res.payload.state})`);
    },
    formatReady: (res) => {
      if (!isHmSpawnReadyPayload(res.payload)) return onProtocolError(res.type, false);
      const nt = res.payload.tenant_nametag ?? '(no nametag)';
      process.stdout.write(`Container ready: ${nt} (${res.payload.tenant_direct_address})\n`);
    },
    formatFailed: (res) => {
      if (!isHmSpawnFailedPayload(res.payload)) return onProtocolError(res.type, false);
      writeStderr(`Failed: ${res.payload.reason}`);
    },
  });
}

async function handleList(cmd: Command, lOpts: ListOpts): Promise<void> {
  await runWithTransport(cmd, async ({ transport, timeoutMs, json }) => {
    const payload: Record<string, unknown> = {};
    if (lOpts.state) payload['state_filter'] = lOpts.state;

    const req = createHmcpRequest('hm.list', payload);
    const res = await transport.sendRequest(req, timeoutMs);

    if (isErrorResponse(res)) {
      handleHmError(res, json);
      return;
    }

    if (json) {
      printJson(res);
      return;
    }

    if (!isHmListResultPayload(res.payload)) {
      onProtocolError(res.type, json);
      return;
    }
    printInstanceTable(res.payload.instances);
  });
}

function printInstanceTable(instances: readonly HmInstanceSummary[]): void {
  const header = ['NAME', 'ID', 'TEMPLATE', 'STATE', 'CREATED'];
  const rows: string[][] = [header];
  for (const inst of instances) {
    rows.push([
      inst.instance_name,
      inst.instance_id,
      inst.template_id,
      inst.state,
      inst.created_at,
    ]);
  }
  const widths = header.map((_, col) =>
    Math.max(...rows.map((r) => (r[col] ?? '').length)),
  );
  for (const r of rows) {
    const line = r.map((cell, i) => (cell ?? '').padEnd(widths[i] ?? 0)).join('  ');
    process.stdout.write(`${line.trimEnd()}\n`);
  }
}

async function handleSimple(
  cmd: Command,
  type: HmcpRequestType,
  nameOrId: string,
  opts: NameOrIdOpts,
  onOk: (res: HmcpResponse, nameOrId: string) => void,
): Promise<void> {
  await runWithTransport(cmd, async ({ transport, timeoutMs, json }) => {
    const req = createHmcpRequest(type, targetPayload(nameOrId, opts));
    const res = await transport.sendRequest(req, timeoutMs);
    if (isErrorResponse(res)) {
      handleHmError(res, json);
      return;
    }
    if (json) {
      printJson(res);
      return;
    }
    onOk(res, nameOrId);
  });
}

async function handleStop(cmd: Command, nameOrId: string, opts: NameOrIdOpts): Promise<void> {
  await handleSimple(cmd, 'hm.stop', nameOrId, opts, (res) => {
    if (!isHmStopResultPayload(res.payload)) return onProtocolError(res.type, false);
    process.stdout.write(`Stopped: ${res.payload.instance_name} (${res.payload.instance_id})\n`);
  });
}

async function handleStart(cmd: Command, nameOrId: string, opts: NameOrIdOpts): Promise<void> {
  await runStreamingLifecycle(cmd, 'hm.start', targetPayload(nameOrId, opts), {
    ackType: 'hm.start_ack',
    readyTypes: ['hm.start_ready'],
    failedType: 'hm.start_failed',
    formatAck: (res) => {
      if (!isHmStartAckPayload(res.payload)) return onProtocolError(res.type, false);
      writeStderr(`Accepted: ${res.payload.instance_id} (${res.payload.state})`);
    },
    formatReady: (res) => {
      if (!isHmStartReadyPayload(res.payload)) return onProtocolError(res.type, false);
      const nt = res.payload.tenant_nametag ?? '(no nametag)';
      process.stdout.write(`Container ready: ${nt} (${res.payload.tenant_direct_address})\n`);
    },
    formatFailed: (res) => {
      if (!isHmStartFailedPayload(res.payload)) return onProtocolError(res.type, false);
      writeStderr(`Failed: ${res.payload.reason}`);
    },
  });
}

async function handleInspect(cmd: Command, nameOrId: string, opts: NameOrIdOpts): Promise<void> {
  await handleSimple(cmd, 'hm.inspect', nameOrId, opts, (res) => {
    if (!isHmInspectResultPayload(res.payload)) return onProtocolError(res.type, false);
    const p = res.payload;
    const rows: Array<[string, string]> = [
      ['instance_id',          p.instance_id],
      ['instance_name',        p.instance_name],
      ['state',                p.state],
      ['template_id',          p.template_id],
      ['tenant_pubkey',        p.tenant_pubkey ?? '(none)'],
      ['tenant_direct_address', p.tenant_direct_address ?? '(none)'],
      ['tenant_nametag',       p.tenant_nametag ?? '(none)'],
      ['created_at',           p.created_at],
      ['last_heartbeat_at',    p.last_heartbeat_at ?? '(never)'],
      ['docker_container_id',  p.docker_container_id ?? '(none)'],
    ];
    const keyWidth = Math.max(...rows.map(([k]) => k.length));
    for (const [k, v] of rows) {
      process.stdout.write(`${`${k}:`.padEnd(keyWidth + 2)} ${v}\n`);
    }
  });
}

async function handleCmd(
  cmd: Command,
  nameOrId: string,
  command: string,
  cOpts: CmdOpts,
): Promise<void> {
  let params: Record<string, unknown> | undefined;
  let cmdTimeoutMs: number | undefined;
  try {
    params = parseJsonParams(cOpts.params);
    if (cOpts.cmdTimeout !== undefined) {
      cmdTimeoutMs = parseTimeout(cOpts.cmdTimeout, DEFAULT_TIMEOUT_MS);
    }
  } catch (err) {
    writeStderr((err as Error).message);
    process.exitCode = 1;
    return;
  }

  await runWithTransport(cmd, async ({ transport, timeoutMs, json }) => {
    const base = targetPayload(nameOrId, cOpts);
    const payload: HmCommandPayload = {
      ...(base as { instance_id?: string; instance_name?: string }),
      command,
      ...(params ? { params } : {}),
      ...(cmdTimeoutMs ? { timeout_ms: cmdTimeoutMs } : {}),
    };

    // If cmdTimeout is set, give the transport TRANSPORT_HEADROOM_MS past the
    // tenant's own execution timer so the reply has time to travel back over
    // the relay before we give up.
    const txTimeout = cmdTimeoutMs ? cmdTimeoutMs + TRANSPORT_HEADROOM_MS : timeoutMs;
    const req = createHmcpRequest('hm.command', payload as unknown as Record<string, unknown>);
    const res = await transport.sendRequest(req, txTimeout);

    if (isErrorResponse(res)) {
      handleHmError(res, json);
      return;
    }

    if (json) {
      printJson(res);
      return;
    }

    if (!isHmCommandResultPayload(res.payload)) {
      onProtocolError(res.type, json);
      return;
    }
    printJson(res.payload.result);
  });
}

async function handleRemove(cmd: Command, nameOrId: string, opts: NameOrIdOpts): Promise<void> {
  await handleSimple(cmd, 'hm.remove', nameOrId, opts, (res) => {
    const p = res.payload as { instance_name?: string; instance_id?: string };
    process.stdout.write(`Removed: ${p.instance_name ?? p.instance_id ?? nameOrId}\n`);
  });
}

async function handlePause(cmd: Command, nameOrId: string, opts: NameOrIdOpts): Promise<void> {
  await handleSimple(cmd, 'hm.pause', nameOrId, opts, (res) => {
    const p = res.payload as { instance_name?: string; instance_id?: string };
    process.stdout.write(`Paused: ${p.instance_name ?? p.instance_id ?? nameOrId}\n`);
  });
}

async function handleResume(cmd: Command, nameOrId: string, opts: NameOrIdOpts): Promise<void> {
  // resume has no distinct ack type; the tenant emits ready/result directly.
  await runStreamingLifecycle(cmd, 'hm.resume', targetPayload(nameOrId, opts), {
    ackType: '__no_ack__',
    readyTypes: ['hm.resume_ready', 'hm.resume_result'],
    failedType: 'hm.resume_failed',
    formatAck: () => { /* no ack for resume */ },
    formatReady: (res) => {
      const p = isPlainObject(res.payload) ? res.payload : {};
      const label = (typeof p['instance_name'] === 'string' && p['instance_name'])
        || (typeof p['instance_id'] === 'string' && p['instance_id'])
        || nameOrId;
      process.stdout.write(`Ready: ${label}\n`);
    },
    formatFailed: (res) => {
      const p = isPlainObject(res.payload) ? res.payload : {};
      const reason = typeof p['reason'] === 'string' ? p['reason'] : 'resume failed';
      writeStderr(`Failed: ${reason}`);
    },
  });
}

async function handleHelp(cmd: Command): Promise<void> {
  await runWithTransport(cmd, async ({ transport, timeoutMs, json }) => {
    const req = createHmcpRequest('hm.help', {});
    const res = await transport.sendRequest(req, timeoutMs);
    if (isErrorResponse(res)) {
      handleHmError(res, json);
      return;
    }
    if (json) {
      printJson(res);
      return;
    }
    if (!isHmHelpResultPayload(res.payload)) {
      onProtocolError(res.type, json);
      return;
    }
    process.stdout.write(`HMCP version: ${res.payload.version}\nCommands:\n`);
    for (const c of res.payload.commands) {
      process.stdout.write(`  ${String(c)}\n`);
    }
  });
}

// =============================================================================
// Command tree
// =============================================================================

export function createHostCommand(): Command {
  const host = new Command('host')
    .description('HMCP: controller → host manager (over Sphere DM)')
    .option('--manager <address>', 'Host manager address (@nametag, DIRECT://hex, or hex pubkey)')
    .option('--json', 'Output raw JSON response')
    .option('--timeout <ms>', 'Override default request timeout (ms)', String(DEFAULT_TIMEOUT_MS));

  // Render the shared options in every subcommand's --help so discovery
  // doesn't require scrolling up to `sphere host --help`. Commander
  // forwards the values automatically; this just makes them visible.
  const inheritedHelp =
    'Inherited options:\n' +
    '  --manager <address>  Host manager address (@nametag, DIRECT://hex, or hex pubkey)\n' +
    '  --json               Output raw JSON response\n' +
    '  --timeout <ms>       Override default request timeout (ms)';

  host
    .command('spawn <name>')
    .description('Spawn a new tenant instance from a template')
    .requiredOption('--template <id>', 'Template ID to instantiate')
    .option('--nametag <n>', 'Nametag to register for the tenant')
    // Note: single-arg form (no ellipsis) + argParser accumulator.
    // The variadic form `<KEY=VAL...>` greedily consumes every subsequent
    // non-flag token — including the positional `<name>` that follows. Users
    // repeat `--env FOO=1 --env BAR=2` to pass multiple pairs.
    .addOption(
      new Option('--env <KEY=VAL>', 'Environment variable pair (repeat for multiple)')
        .argParser((value: string, previous: string[] | undefined) =>
          previous ? [...previous, value] : [value]) as Option,
    )
    .action(async function (this: Command, name: string, sOpts: SpawnOpts) {
      await handleSpawn(this, name, sOpts);
    });

  host
    .command('list')
    .description('List tenant instances managed by this host')
    .option('--state <filter>', 'Filter by state (CREATED, BOOTING, RUNNING, STOPPED, FAILED)')
    .action(async function (this: Command, lOpts: ListOpts) {
      await handleList(this, lOpts);
    });

  host
    .command('stop <name>')
    .description('Stop a running tenant instance')
    .option('--id', 'Treat <name> as an instance_id')
    .action(async function (this: Command, nameOrId: string, opts: NameOrIdOpts) {
      await handleStop(this, nameOrId, opts);
    });

  host
    .command('start <name>')
    .description('Start a stopped tenant instance')
    .option('--id', 'Treat <name> as an instance_id')
    .action(async function (this: Command, nameOrId: string, opts: NameOrIdOpts) {
      await handleStart(this, nameOrId, opts);
    });

  host
    .command('inspect <name>')
    .description('Inspect a tenant instance')
    .option('--id', 'Treat <name> as an instance_id')
    .action(async function (this: Command, nameOrId: string, opts: NameOrIdOpts) {
      await handleInspect(this, nameOrId, opts);
    });

  host
    .command('cmd <name> <command>')
    .description('Send a command to a tenant instance')
    .option('--params <json>', 'JSON object of command parameters')
    .option('--id', 'Treat <name> as an instance_id')
    .option('--cmd-timeout <ms>', 'Per-command execution timeout (ms)')
    .action(async function (this: Command, nameOrId: string, command: string, cOpts: CmdOpts) {
      await handleCmd(this, nameOrId, command, cOpts);
    });

  host
    .command('remove <name>')
    .description('Remove a tenant instance record (and its container)')
    .option('--id', 'Treat <name> as an instance_id')
    .action(async function (this: Command, nameOrId: string, opts: NameOrIdOpts) {
      await handleRemove(this, nameOrId, opts);
    });

  host
    .command('pause <name>')
    .description('Pause a running tenant instance')
    .option('--id', 'Treat <name> as an instance_id')
    .action(async function (this: Command, nameOrId: string, opts: NameOrIdOpts) {
      await handlePause(this, nameOrId, opts);
    });

  host
    .command('resume <name>')
    .description('Resume a paused tenant instance')
    .option('--id', 'Treat <name> as an instance_id')
    .action(async function (this: Command, nameOrId: string, opts: NameOrIdOpts) {
      await handleResume(this, nameOrId, opts);
    });

  host
    .command('help')
    .description('Ask the host manager for its supported commands')
    .action(async function (this: Command) {
      await handleHelp(this);
    });

  // Attach the shared-options help text to every subcommand. Iterating after
  // construction keeps the subcommand definitions above small and ensures
  // any newly-added subcommand automatically inherits the help surface.
  for (const sub of host.commands) {
    sub.addHelpText('after', `\n${inheritedHelp}`);
  }

  return host;
}

// Exported for unit tests.
export { parseEnvPairs, parseJsonParams, parseTimeout, targetPayload };

// Re-exported for external consumers wanting to inspect the request type union.
export type { HmcpRequest };
