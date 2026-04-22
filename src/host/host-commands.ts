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
  // Merge options from this command and its parents — commander keeps them local.
  const merged: GlobalOpts = {};
  let current: Command | null = cmd;
  while (current) {
    const opts = current.opts<GlobalOpts>();
    if (opts.manager !== undefined && merged.manager === undefined) merged.manager = opts.manager;
    if (opts.json !== undefined && merged.json === undefined) merged.json = opts.json;
    if (opts.timeout !== undefined && merged.timeout === undefined) merged.timeout = opts.timeout;
    current = current.parent;
  }
  return merged;
}

function parseTimeout(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid timeout: ${raw}`);
  }
  return Math.floor(n);
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

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeStderr(msg: unknown): void {
  const s = typeof msg === 'string' ? msg : String(msg ?? 'unknown error');
  process.stderr.write(s.endsWith('\n') ? s : `${s}\n`);
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
// Subcommand handlers
// =============================================================================

async function handleSpawn(cmd: Command, name: string, sOpts: SpawnOpts): Promise<void> {
  const env = parseEnvPairs(sOpts.env);
  await runWithTransport(cmd, async ({ transport, json }) => {
    const payload: Record<string, unknown> = {
      template_id: sOpts.template,
      instance_name: name,
    };
    if (sOpts.nametag) payload['nametag'] = sOpts.nametag;
    if (env) payload['env'] = env;

    const req = createHmcpRequest('hm.spawn', payload);

    const collected: HmcpResponse[] = [];
    await transport.sendRequestStream(req, (res) => {
      collected.push(res);
      return (
        res.type === 'hm.spawn_ready' ||
        res.type === 'hm.spawn_failed' ||
        res.type === 'hm.error'
      );
    });

    if (json) {
      printJson(collected);
      const last = collected[collected.length - 1];
      if (last && (last.type === 'hm.spawn_failed' || last.type === 'hm.error')) {
        process.exitCode = 1;
      }
      return;
    }

    for (const res of collected) {
      if (res.type === 'hm.spawn_ack') {
        const p = res.payload as unknown as HmSpawnAckPayload;
        writeStderr(`Accepted: ${p.instance_id} (${p.state})`);
      } else if (res.type === 'hm.spawn_ready') {
        const p = res.payload as unknown as HmSpawnReadyPayload;
        const nt = p.tenant_nametag ?? '(no nametag)';
        process.stdout.write(`Container ready: ${nt} (${p.tenant_direct_address})\n`);
      } else if (res.type === 'hm.spawn_failed') {
        const p = res.payload as unknown as HmSpawnFailedPayload;
        writeStderr(`Failed: ${p.reason}`);
        process.exitCode = 1;
      } else if (isErrorResponse(res)) {
        handleHmError(res, json);
      }
    }
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

    const p = res.payload as unknown as HmListResultPayload;
    printInstanceTable(p.instances);
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
    const p = res.payload as unknown as HmStopResultPayload;
    process.stdout.write(`Stopped: ${p.instance_name} (${p.instance_id})\n`);
  });
}

async function handleStart(cmd: Command, nameOrId: string, opts: NameOrIdOpts): Promise<void> {
  await runWithTransport(cmd, async ({ transport, json }) => {
    const req = createHmcpRequest('hm.start', targetPayload(nameOrId, opts));

    const collected: HmcpResponse[] = [];
    await transport.sendRequestStream(req, (res) => {
      collected.push(res);
      return (
        res.type === 'hm.start_ready' ||
        res.type === 'hm.start_failed' ||
        res.type === 'hm.error'
      );
    });

    if (json) {
      printJson(collected);
      const last = collected[collected.length - 1];
      if (last && (last.type === 'hm.start_failed' || last.type === 'hm.error')) {
        process.exitCode = 1;
      }
      return;
    }

    for (const res of collected) {
      if (res.type === 'hm.start_ack') {
        const p = res.payload as unknown as HmStartAckPayload;
        writeStderr(`Accepted: ${p.instance_id} (${p.state})`);
      } else if (res.type === 'hm.start_ready') {
        const p = res.payload as unknown as HmStartReadyPayload;
        const nt = p.tenant_nametag ?? '(no nametag)';
        process.stdout.write(`Container ready: ${nt} (${p.tenant_direct_address})\n`);
      } else if (res.type === 'hm.start_failed') {
        const p = res.payload as unknown as HmStartFailedPayload;
        writeStderr(`Failed: ${p.reason}`);
        process.exitCode = 1;
      } else if (isErrorResponse(res)) {
        handleHmError(res, json);
      }
    }
  });
}

async function handleInspect(cmd: Command, nameOrId: string, opts: NameOrIdOpts): Promise<void> {
  await handleSimple(cmd, 'hm.inspect', nameOrId, opts, (res) => {
    const p = res.payload as unknown as HmInspectResultPayload;
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

    // If cmdTimeout is set, give the transport a bit more headroom than the tenant timeout.
    const txTimeout = cmdTimeoutMs ? cmdTimeoutMs + 5_000 : timeoutMs;
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

    const p = res.payload as unknown as HmCommandResultPayload;
    printJson(p.result);
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
  await runWithTransport(cmd, async ({ transport, json }) => {
    const req = createHmcpRequest('hm.resume', targetPayload(nameOrId, opts));

    const collected: HmcpResponse[] = [];
    await transport.sendRequestStream(req, (res) => {
      collected.push(res);
      return (
        res.type === 'hm.resume_ready' ||
        res.type === 'hm.resume_failed' ||
        res.type === 'hm.resume_result' ||
        res.type === 'hm.error'
      );
    });

    if (json) {
      printJson(collected);
      const last = collected[collected.length - 1];
      if (last && (last.type === 'hm.resume_failed' || last.type === 'hm.error')) {
        process.exitCode = 1;
      }
      return;
    }

    for (const res of collected) {
      if (res.type === 'hm.resume_ready' || res.type === 'hm.resume_result') {
        const p = res.payload as { instance_name?: string; instance_id?: string };
        process.stdout.write(`Ready: ${p.instance_name ?? p.instance_id ?? nameOrId}\n`);
      } else if (res.type === 'hm.resume_failed') {
        const p = res.payload as unknown as { reason?: string };
        writeStderr(`Failed: ${p.reason ?? 'resume failed'}`);
        process.exitCode = 1;
      } else if (isErrorResponse(res)) {
        handleHmError(res, json);
      }
    }
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
    const p = res.payload as unknown as HmHelpResultPayload;
    process.stdout.write(`HMCP version: ${p.version}\nCommands:\n`);
    for (const c of p.commands) {
      process.stdout.write(`  ${c}\n`);
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

  host
    .command('spawn <name>')
    .description('Spawn a new tenant instance from a template')
    .requiredOption('--template <id>', 'Template ID to instantiate')
    .option('--nametag <n>', 'Nametag to register for the tenant')
    .addOption(
      new Option('--env <KEY=VAL...>', 'Environment variable pairs')
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

  return host;
}

// Exported for unit tests.
export { parseEnvPairs, parseJsonParams, parseTimeout, targetPayload };

// Re-exported for external consumers wanting to inspect the request type union.
export type { HmcpRequest };
