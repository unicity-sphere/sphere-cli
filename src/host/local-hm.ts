/**
 * Per-user local host-manager (HM) container lifecycle.
 *
 * Each developer who wants to run trader / escrow tenants locally needs
 * their own HM scoped to their controller wallet (see
 * `docs/local-hm.md`). The public HM at `m-swap-soak` reserves its
 * `AUTHORIZED_CONTROLLERS` slot for shared services like the public
 * escrow — it cannot whitelist alice + bob + charlie per soak run.
 *
 * This module brings that local HM up as a Docker container without
 * any docker-compose boilerplate. Shells out to the `docker` CLI rather
 * than depending on `dockerode`: keeps the sphere-cli surface light and
 * makes failures (image missing, socket permission) trivial to
 * reproduce by hand.
 *
 * Two-shot bootstrap. The agentic-hosting HM's drift guard fails the
 * very first boot when `MANAGER_PUBKEY`/`MANAGER_DIRECT_ADDRESS` env
 * vars don't match the wallet it just generated (intentional — protects
 * against pointing the manager at the wrong data dir post-misdeploy).
 * The error message embeds the real pubkey/direct address; we scrape
 * those, stop the failed container, and restart with corrected env.
 * The wallet persists across the restart in the bind-mounted volume so
 * the second boot succeeds cleanly. After that, subsequent invocations
 * reuse the same wallet → no re-bootstrap.
 *
 * Idempotency. `ensureLocalHM()` checks for an existing running HM
 * container by name first and returns its sidecar metadata if present;
 * `stopLocalHM()` is a no-op if no container exists.
 *
 * @see vrogojin/agentic_hosting Dockerfile.host-manager (image build)
 * @see vrogojin/agentic_hosting/src/host-manager/main.ts:484-514
 *      (manager_wallet_created_RECORD_MNEMONIC + drift guard)
 * @see GitHub sphere-cli#48 (issue spec)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// =============================================================================
// Constants
// =============================================================================

/**
 * Default agentic-hosting HM image. The `unicitynetwork` org's
 * `publish-images.sh` script tags every published HM as
 * `<registry>/agentic-hosting/host-manager:<tag>` (see the script's
 * IMAGES table — registry defaults to `ghcr.io/unicitynetwork/agentic-hosting`,
 * but the per-image build paths flatten that to `agentic-hosting/host-manager`).
 *
 * Override with `--hm-image`. Local development builds with the
 * docker-compose file in vrogojin/agentic_hosting/docker yield
 * `docker-host-manager:latest`; pass that via `--hm-image` or
 * `SPHERE_LOCAL_HM_IMAGE` until the public image lands.
 */
export const DEFAULT_HM_IMAGE =
  'ghcr.io/unicitynetwork/agentic-hosting/host-manager:latest';

/**
 * Where the HM expects its wallet + state + templates inside the
 * container. Pinned by the agentic-hosting Dockerfile.
 */
const HM_WALLET_PATH_IN_CONTAINER = '/app/sphere-manager';
const HM_STATE_PATH_IN_CONTAINER = '/app/state';
const HM_TEMPLATES_PATH_IN_CONTAINER = '/app/config/templates.json';

/**
 * Tenants directory: identical-path bind mount strategy.
 *
 * The HM uses `TENANTS_DIR` as the base path for tenant instance dirs
 * (wallet, tokens, escrow). When the HM spawns a tenant, it tells the
 * docker daemon (via the bind-mounted socket) to bind-mount
 * `${TENANTS_DIR}/<instance>/wallet` into `/data/wallet` of the tenant.
 *
 * The trap: the HM runs in a container that shares the docker daemon
 * socket with the host. When the HM asks docker to bind-mount a path
 * that exists only inside the HM container (e.g. a container-only
 * `/var/lib/agentic-hosting/tenants/X`, or a named volume that the host
 * doesn't see at the same path), the daemon resolves the source on the
 * HOST's filesystem, doesn't find it, and silently creates an empty
 * root:root-owned dir there. The tenant's `node` user (uid 1000) then
 * hits EACCES writing its wallet.
 *
 * Fix: mount the host tenants dir at the SAME host path inside the HM.
 * The HM then sees an identical path, the docker daemon finds the same
 * directory on the host, and the bind chain resolves correctly with
 * the right ownership. This is what the agentic-hosting production
 * docker-compose.override.yml does (see its comment block).
 */

/**
 * docker socket path (`/var/run/docker.sock`). Mounted read-write into
 * the HM so it can spawn tenant containers via dockerode. The local user
 * must be in the `docker` group for this mount to be writable.
 */
const DOCKER_SOCKET = '/var/run/docker.sock';

/**
 * Two-shot bootstrap parameters. The HM's first boot fails fast with a
 * ConfigError after Sphere.init returns — the wallet write itself takes
 * <2 s. We poll the container logs at 500ms cadence until the error
 * line appears, then restart.
 */
const BOOTSTRAP_LOG_POLL_MS = 500;
const BOOTSTRAP_LOG_TIMEOUT_MS = 60_000;
const READY_LOG_POLL_MS = 500;
const DEFAULT_READY_TIMEOUT_MS = 90_000;

/**
 * The HM log line we wait for on healthy boot. Emitted by the
 * structured logger in host-manager/main.ts:515 after the drift guard
 * passes.
 */
const READY_LOG_MARKER = 'sphere_initialized';

/**
 * Failure markers — the HM's drift guards emit two distinct error
 * shapes depending on which check fails. We need both because the
 * bootstrap dance reveals each value on a different boot:
 *
 *   - First boot (placeholder pubkey + placeholder DA): the pubkey
 *     check fails first → DRIFT_GUARD_MARKER fires
 *   - Second boot (real pubkey + pubkey-derived DA): the pubkey check
 *     passes, the DA check fails → DIRECT_ADDRESS_DRIFT_MARKER fires
 *
 * A second-boot failure with neither marker (e.g., entrypoint crashed)
 * surfaces to the operator as a timeout, not a silent retry.
 */
const DRIFT_GUARD_MARKER = 'MANAGER_PUBKEY mismatch';
const DIRECT_ADDRESS_DRIFT_MARKER = 'MANAGER_DIRECT_ADDRESS mismatch';

/**
 * The placeholder values we ship to the HM on first boot. They MUST be
 * valid secp256k1 hex (parseManagerConfig validates the format before
 * the drift guard runs). The exact value doesn't matter — they'll be
 * overwritten on the second boot — but using all-zeros risks the
 * scep256k1 validator rejecting an invalid curve point. We use a known
 * valid generator-derived pubkey.
 *
 * `01` as the private key gives `0279be667ef9dcbbac55a06295ce870b07...`
 * (compressed secp256k1 generator G). This is a well-known valid pubkey
 * and is obviously not a real manager key, so any operator who sees it
 * in logs knows it's a bootstrap placeholder.
 */
const PLACEHOLDER_PUBKEY =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const PLACEHOLDER_DIRECT_ADDRESS =
  `DIRECT://${PLACEHOLDER_PUBKEY}`;

// =============================================================================
// Types
// =============================================================================

export interface LocalHmConfig {
  /**
   * The controller wallet's chain pubkey (33-byte secp256k1 compressed,
   * 66 hex chars). The HM is brought up with this as its only
   * `AUTHORIZED_CONTROLLERS` entry.
   */
  readonly controllerPubkey: string;
  /**
   * Base directory under which the local HM keeps its persistent state
   * (manager wallet, state.json, tenant records). One subdirectory per
   * controller pubkey prefix; see `localHmDataDir()`.
   */
  readonly baseDir: string;
  /**
   * Path to a templates.json the HM should consult. When omitted, the
   * bundled `DEFAULT_TEMPLATES` (trader-agent + escrow-service) are
   * written into the per-controller data dir. Pass an explicit path to
   * point at a local agentic_hosting checkout instead.
   */
  readonly templatesFile?: string;
  /**
   * HM container image reference. Defaults to {@link DEFAULT_HM_IMAGE}.
   * Override with `--hm-image` or `SPHERE_LOCAL_HM_IMAGE`.
   */
  readonly image?: string;
  /**
   * Health-port to expose on `127.0.0.1`. The HM listens on 9401
   * internally; we map each per-developer HM to a different host port
   * derived from the wallet prefix to avoid collisions. Pass an explicit
   * value to override.
   */
  readonly healthPort?: number;
}

/**
 * Sidecar metadata written to `${localHmDataDir}/sphere-cli-meta.json`
 * after a successful boot. Read on `local-status` and re-used by
 * subsequent `local-spawn` calls so we don't re-run the two-shot
 * bootstrap unnecessarily.
 */
export interface LocalHmMetadata {
  readonly controllerPubkey: string;
  readonly managerPubkey: string;
  readonly managerDirectAddress: string;
  readonly managerNametag: string;
  readonly hostId: string;
  readonly containerName: string;
  readonly image: string;
  readonly healthPort: number;
  readonly createdAt: string;
}

export interface LocalHmStatus {
  readonly running: boolean;
  readonly containerName: string;
  readonly metadata: LocalHmMetadata | null;
  /**
   * Only set when `running === true`. The actual docker container id
   * (long form). Useful for `docker logs` / `docker exec` follow-ups.
   */
  readonly containerId?: string;
}

// =============================================================================
// Path conventions
// =============================================================================

/**
 * The wallet-pubkey-prefix used to name container + scope data dirs.
 * First 12 chars of the chain pubkey hex — long enough to avoid
 * realistic collisions on a single developer's machine, short enough
 * to fit in container names + paths cleanly.
 */
export function walletPrefix(controllerPubkey: string): string {
  if (controllerPubkey.length < 12) {
    throw new Error(
      `controllerPubkey too short (${controllerPubkey.length} hex chars; need >= 12)`,
    );
  }
  return controllerPubkey.slice(0, 12).toLowerCase();
}

/**
 * Per-controller data directory. All paths below it are owned by
 * sphere-cli; the operator should never need to touch them directly.
 */
export function localHmDataDir(baseDir: string, controllerPubkey: string): string {
  return path.join(baseDir, walletPrefix(controllerPubkey));
}

/**
 * Stable container name. `sphere-hm-` prefix keeps every local HM
 * grouped under `docker ps --filter name=sphere-hm-`.
 */
export function localHmContainerName(controllerPubkey: string): string {
  return `sphere-hm-${walletPrefix(controllerPubkey)}`;
}

/**
 * Derive a deterministic health port from the wallet prefix so two
 * developers on the same host don't collide on `127.0.0.1:9401`.
 *
 * The agentic-hosting HM listens on `UNICITY_HEALTH_PORT` for a
 * diagnostics HTTP endpoint. Different per-developer HMs need
 * different host-side ports; the in-container port stays 9401.
 *
 * Range: `[9401, 9401 + 1023]` — 1024 distinct slots, derived as the
 * first 5 hex digits of the prefix mod 1024. Deterministic so re-runs
 * pick the same port and operators can curl it without a registry.
 */
export function deriveHealthPort(controllerPubkey: string): number {
  const slot = parseInt(controllerPubkey.slice(0, 5), 16) & 0x3ff; // [0, 1023]
  return 9401 + slot;
}

/**
 * Manager nametag — same formula as agentic_hosting/host-manager/main.ts:467
 * (`m-${host_id}` slugified to a-z0-9, max 12 chars, lowercased). MUST
 * stay aligned with the HM so the nametag the HM publishes matches what
 * we record in sidecar metadata.
 */
export function deriveManagerNametag(hostId: string): string {
  return `m-${hostId.replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase()}`;
}

/**
 * `HOST_ID` for the agentic-hosting HM. Must match
 * `^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$` (see `agentic_hosting/src/shared/config.ts`
 * line 21 `HOST_ID_RE`). Using `u-<wallet-prefix>` keeps it visually
 * distinct from the manager nametag pattern (which adds an `m-`).
 */
export function deriveHostId(controllerPubkey: string): string {
  return `u-${walletPrefix(controllerPubkey)}`;
}

// =============================================================================
// Sidecar metadata I/O
// =============================================================================

function metadataPath(dataDir: string): string {
  return path.join(dataDir, 'sphere-cli-meta.json');
}

export function readMetadata(dataDir: string): LocalHmMetadata | null {
  const p = metadataPath(dataDir);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown;
    if (!isLocalHmMetadata(raw)) return null;
    return raw;
  } catch {
    return null;
  }
}

function isLocalHmMetadata(v: unknown): v is LocalHmMetadata {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['controllerPubkey']      === 'string' &&
    typeof o['managerPubkey']         === 'string' &&
    typeof o['managerDirectAddress']  === 'string' &&
    typeof o['managerNametag']        === 'string' &&
    typeof o['hostId']                === 'string' &&
    typeof o['containerName']         === 'string' &&
    typeof o['image']                 === 'string' &&
    typeof o['healthPort']            === 'number' &&
    typeof o['createdAt']             === 'string'
  );
}

function writeMetadata(dataDir: string, m: LocalHmMetadata): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(metadataPath(dataDir), JSON.stringify(m, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
}

// =============================================================================
// docker CLI wrappers
// =============================================================================
//
// Shells out via `child_process.execFile` (no shell metachar expansion —
// passes argv directly to the kernel). Keeps the surface narrow and
// audit-friendly compared with `child_process.exec` or a `dockerode`
// dependency. The CLI's `docker` binary is widely available on dev hosts
// already.

interface ContainerInspectResult {
  readonly id: string;
  readonly running: boolean;
  readonly image: string;
}

async function dockerExists(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['version', '--format', '{{.Client.Version}}']);
    return true;
  } catch {
    return false;
  }
}

async function inspectContainer(name: string): Promise<ContainerInspectResult | null> {
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['inspect', '--format', '{{.Id}}|{{.State.Running}}|{{.Config.Image}}', name],
    );
    const parts = stdout.trim().split('|');
    if (parts.length !== 3) return null;
    return {
      id: parts[0] ?? '',
      running: (parts[1] ?? '').toLowerCase() === 'true',
      image: parts[2] ?? '',
    };
  } catch {
    return null;
  }
}

async function readContainerLogs(name: string, lines: number = 200): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync('docker', [
      'logs', '--tail', String(lines), name,
    ], { maxBuffer: 16 * 1024 * 1024 });
    // Container processes are free to write to either stream; merge so
    // callers don't have to chase log lines across two buffers.
    return `${stdout}${stderr}`;
  } catch {
    return '';
  }
}

async function dockerRm(name: string): Promise<void> {
  // `--force` so we don't need a separate stop + sleep when scrapping
  // a container that's still running (e.g. mid-bootstrap retry).
  // Ignore failure — caller's intent is "make sure it's gone."
  try {
    await execFileAsync('docker', ['rm', '--force', name]);
  } catch {
    // no-op
  }
}

async function dockerStop(name: string): Promise<void> {
  try {
    await execFileAsync('docker', ['stop', name]);
  } catch {
    // no-op
  }
}

interface DockerRunArgs {
  readonly name: string;
  readonly image: string;
  readonly env: Record<string, string>;
  readonly volumes: ReadonlyArray<{ host: string; container: string; readonly?: boolean }>;
  readonly ports: ReadonlyArray<{ host: number; container: number }>;
  readonly groupAddDockerGid?: number;
}

async function dockerRunDetached(args: DockerRunArgs): Promise<string> {
  const argv: string[] = ['run', '--detach', '--name', args.name, '--restart', 'unless-stopped'];

  // group_add for the docker socket — without this, mounting the socket
  // works but the container can't write to it (EACCES).
  if (args.groupAddDockerGid !== undefined) {
    argv.push('--group-add', String(args.groupAddDockerGid));
  }

  for (const [k, v] of Object.entries(args.env)) {
    argv.push('--env', `${k}=${v}`);
  }
  for (const vol of args.volumes) {
    const ro = vol.readonly === true ? ':ro' : '';
    argv.push('--volume', `${vol.host}:${vol.container}${ro}`);
  }
  for (const p of args.ports) {
    // Bind to 127.0.0.1 only — the health endpoint is diagnostics-only,
    // we never want it exposed on 0.0.0.0 by default.
    argv.push('--publish', `127.0.0.1:${p.host}:${p.container}`);
  }
  argv.push(args.image);

  const { stdout } = await execFileAsync('docker', argv);
  return stdout.trim();
}

/**
 * Read the host-side gid of the `docker` group. The HM container's
 * user (`node`) needs supplementary group membership matching this
 * gid to write to the bind-mounted docker socket. Falls back to the
 * `999` convention used in the agentic_hosting docker-compose example
 * if `/etc/group` doesn't have a `docker` entry.
 */
export function detectDockerGid(): number {
  try {
    const groupFile = fs.readFileSync('/etc/group', 'utf8');
    const match = groupFile.match(/^docker:[^:]*:(\d+):/m);
    if (match && match[1]) return Number.parseInt(match[1], 10);
  } catch {
    // /etc/group not readable — fall back to default.
  }
  return 999;
}

// =============================================================================
// Two-shot bootstrap helpers
// =============================================================================

/**
 * Match the HM's drift-guard error messages and extract whichever real
 * wallet values the error message reveals. The agentic_hosting source
 * (host-manager/main.ts:502-514) does TWO sequential checks against
 * the loaded wallet identity:
 *
 *   1. `pubkeysEqual(loadedPubkey, config.manager_pubkey)` — if false,
 *      throws `MANAGER_PUBKEY mismatch: env="…", wallet="<loadedPubkey>"`
 *      and exits BEFORE the next check.
 *   2. `loadedDirectAddress !== config.manager_direct_address` — if
 *      true, throws `MANAGER_DIRECT_ADDRESS mismatch: env="…", wallet="<addr>"`.
 *
 * Because the checks are sequential, a single boot can reveal AT MOST
 * one of the two real values. The bootstrap caller has to do multiple
 * boots:
 *   - Boot 1 (placeholder both)        → pubkey mismatch surfaces (boot 2's input is real pubkey)
 *   - Boot 2 (real pubkey, derived DA) → direct-address mismatch surfaces (boot 3's input is real both)
 *   - Boot 3 (real both)               → succeeds
 *
 * A sphere wallet's directAddress is NOT `DIRECT://<chainPubkey>` —
 * sphere-sdk computes a custom 36-byte address with a `0000…` prefix.
 * That's why a 2-shot bootstrap (the old design) fails on boot 2 with
 * a direct-address mismatch.
 *
 * Returns null when no drift marker present yet (poll again).
 * Returns the field(s) the error reveals; the missing field is `null`
 * and the caller carries forward its current best guess (placeholder
 * on boot 1, pubkey-derived on boot 2).
 */
export function parseDriftError(logs: string): {
  managerPubkey: string | null;
  managerDirectAddress: string | null;
} | null {
  if (!logs.includes(DRIFT_GUARD_MARKER) && !logs.includes(DIRECT_ADDRESS_DRIFT_MARKER)) {
    return null;
  }
  // The pubkey mismatch line uses `wallet="<66-130 hex>"` (compressed/
  // x-only/uncompressed pubkey hex). Match the most recent occurrence —
  // logs may accumulate multiple lines across restarts.
  const pubkeyMatches = Array.from(
    logs.matchAll(/MANAGER_PUBKEY mismatch:[^\n]*wallet=["']([0-9a-fA-F]{66,130})["']/g),
  );
  // The direct-address mismatch line uses `wallet="DIRECT://<hex>"`.
  // Match its most recent occurrence too.
  const daMatches = Array.from(
    logs.matchAll(/MANAGER_DIRECT_ADDRESS mismatch:[^\n]*wallet=["'](DIRECT:\/\/[0-9a-fA-F]+)["']/g),
  );
  const pubkeyMatch = pubkeyMatches[pubkeyMatches.length - 1];
  const daMatch = daMatches[daMatches.length - 1];
  if (!pubkeyMatch && !daMatch) return null;
  return {
    managerPubkey: pubkeyMatch ? pubkeyMatch[1].toLowerCase() : null,
    managerDirectAddress: daMatch ? daMatch[1] : null,
  };
}

/**
 * Poll a container's logs until either the success marker or any of
 * the drift markers appears. Returns whichever fired first, or
 * timeout. The drift result reports whichever real fields the HM's
 * error message revealed; the caller is responsible for carrying
 * forward whatever it hasn't learnt yet.
 */
type WaitForLogResult =
  | { kind: 'ready' }
  | { kind: 'drift'; managerPubkey: string | null; managerDirectAddress: string | null }
  | { kind: 'timeout'; lastLogs: string };

async function waitForBootSignal(containerName: string, timeoutMs: number): Promise<WaitForLogResult> {
  const deadline = Date.now() + timeoutMs;
  let lastLogs = '';
  while (Date.now() < deadline) {
    lastLogs = await readContainerLogs(containerName, 500);
    const drift = parseDriftError(lastLogs);
    if (drift) {
      return { kind: 'drift', ...drift };
    }
    if (lastLogs.includes(READY_LOG_MARKER)) {
      return { kind: 'ready' };
    }
    await new Promise((r) => setTimeout(r, BOOTSTRAP_LOG_POLL_MS));
  }
  return { kind: 'timeout', lastLogs };
}

// =============================================================================
// Build env / docker args for the HM
// =============================================================================

/**
 * Compute the HOST_ID + MANAGER_PUBKEY env bag for the HM. Pure
 * function — unit-tested in `local-hm.test.ts` without touching docker
 * or the filesystem.
 *
 * `managerPubkey`/`managerDirectAddress` accept the placeholder values
 * for the bootstrap boot, then the real wallet values for the second
 * boot. Callers should pass the appropriate value for the phase.
 */
export function buildHmEnv(opts: {
  readonly controllerPubkey: string;
  readonly hostId: string;
  readonly managerPubkey: string;
  readonly managerDirectAddress: string;
  /**
   * HOST-side absolute path to the tenants directory. This same path
   * is also bind-mounted into the HM container at the same location,
   * so docker-in-docker bind mounts the HM issues against
   * `${tenantsHostDir}/<instance>/wallet` resolve correctly on the
   * host. See the comment block above this file's HM constants for
   * the docker-daemon path-resolution rationale.
   */
  readonly tenantsHostDir: string;
  readonly network?: string;
  readonly healthPort: number;
}): Record<string, string> {
  return {
    HOST_ID:                  opts.hostId,
    AUTHORIZED_CONTROLLERS:   opts.controllerPubkey,
    MANAGER_PUBKEY:           opts.managerPubkey,
    MANAGER_DIRECT_ADDRESS:   opts.managerDirectAddress,
    SPHERE_MANAGER_DATA_DIR:  HM_WALLET_PATH_IN_CONTAINER,
    TEMPLATES_PATH:           HM_TEMPLATES_PATH_IN_CONTAINER,
    TENANTS_DIR:              opts.tenantsHostDir,
    PERSISTENCE_PATH:         path.posix.join(HM_STATE_PATH_IN_CONTAINER, 'state.json'),
    DOCKER_SOCKET:            DOCKER_SOCKET,
    UNICITY_NETWORK:          opts.network ?? 'testnet',
    UNICITY_HEALTH_PORT:      String(opts.healthPort),
    LOG_LEVEL:                'info',
  };
}

// =============================================================================
// Templates.json bundling
// =============================================================================

/**
 * Default templates.json bundled with sphere-cli. Mirrors the
 * agentic_hosting/config/templates.json entries for trader-agent +
 * escrow-service so the local HM can spawn either without needing
 * the operator to ship their own templates registry.
 *
 * Image versions:
 *   - `trader:v0.2` — built from sphere-sdk@550114c with the four
 *     rotations the v0.1 image predated (#456 / #457 / #464 / #447).
 *     Cut as `vrogojin/trader-service` release v0.2 (2026-06-10).
 *   - `escrow:v0.3` — current production escrow image.
 *
 * Bumps land via agentic_hosting follow-ups + CLI updates.
 */
export const DEFAULT_TEMPLATES: { templates: ReadonlyArray<unknown> } = {
  templates: [
    {
      template_id: 'trader-agent',
      image: 'ghcr.io/vrogojin/agentic-hosting/trader:v0.2',
      entrypoint: ['node', '/app/dist/acp-adapter/main.js'],
      env_defaults: {
        LOG_LEVEL: 'info',
        SPHERE_NETWORK: 'testnet',
        TRADER_SCAN_INTERVAL_MS: '30000',
        TRADER_MAX_ACTIVE_INTENTS: '10',
      },
      resources: { memory_mb: 512, pids_limit: 256 },
    },
    {
      template_id: 'escrow-service',
      image: 'ghcr.io/vrogojin/agentic-hosting/escrow:v0.3',
      entrypoint: ['node', '/app/dist/acp-adapter/main.js'],
      env_defaults: {
        LOG_LEVEL: 'info',
        SPHERE_NETWORK: 'testnet',
        SWAP_TIMEOUT_DEFAULT: '300',
        MAX_PENDING_SWAPS: '100',
      },
      resources: { memory_mb: 1024, pids_limit: 512 },
    },
  ],
};

/**
 * Write the bundled templates.json into the per-controller data dir.
 * Idempotent — overwrites on every call so a CLI upgrade with new
 * template defaults takes effect without a rebuild. If the operator
 * supplied their own templates file (via `--templates-file`), we copy
 * theirs in instead.
 */
export function ensureTemplatesFile(dataDir: string, sourceFile?: string): string {
  fs.mkdirSync(dataDir, { recursive: true });
  const target = path.join(dataDir, 'templates.json');
  if (sourceFile) {
    if (!fs.existsSync(sourceFile)) {
      throw new Error(`Templates file not found: ${sourceFile}`);
    }
    fs.copyFileSync(sourceFile, target);
  } else {
    fs.writeFileSync(target, JSON.stringify(DEFAULT_TEMPLATES, null, 2) + '\n', 'utf8');
  }
  return target;
}

// =============================================================================
// Public lifecycle API
// =============================================================================

/**
 * Get the current status of the local HM container for a given
 * controller wallet. Combines a docker inspect lookup with the
 * persisted sidecar metadata.
 *
 * Does NOT modify any state. Safe to call repeatedly.
 */
export async function localHmStatus(opts: {
  controllerPubkey: string;
  baseDir: string;
}): Promise<LocalHmStatus> {
  const containerName = localHmContainerName(opts.controllerPubkey);
  const dataDir = localHmDataDir(opts.baseDir, opts.controllerPubkey);
  const metadata = readMetadata(dataDir);
  const inspect = await inspectContainer(containerName);
  if (!inspect) {
    return { running: false, containerName, metadata };
  }
  return {
    running: inspect.running,
    containerName,
    containerId: inspect.id,
    metadata,
  };
}

/**
 * Ensure a local HM container is running for the controller wallet.
 * Idempotent — returns the existing metadata if the container is
 * already up. Otherwise runs the full two-shot bootstrap.
 *
 * The returned metadata's `managerDirectAddress` is the address the
 * caller should pass as `--manager` for subsequent `sphere host …`
 * subcommands against this local HM.
 */
export async function ensureLocalHM(config: LocalHmConfig): Promise<LocalHmMetadata> {
  if (!(await dockerExists())) {
    throw new Error(
      'docker CLI not found. Install Docker Engine and ensure your user is in the docker group.',
    );
  }

  const image = config.image ?? process.env['SPHERE_LOCAL_HM_IMAGE'] ?? DEFAULT_HM_IMAGE;
  const healthPort = config.healthPort ?? deriveHealthPort(config.controllerPubkey);
  const containerName = localHmContainerName(config.controllerPubkey);
  const dataDir = localHmDataDir(config.baseDir, config.controllerPubkey);
  const hostId = deriveHostId(config.controllerPubkey);
  const managerNametag = deriveManagerNametag(hostId);

  const existing = await inspectContainer(containerName);
  if (existing && existing.running) {
    const meta = readMetadata(dataDir);
    if (meta) return meta;
    // Container is running but we have no sidecar metadata — most
    // likely a stale run from before sphere-cli wrote metadata.
    // Reset and restart so we have a known-good record.
    await dockerRm(containerName);
  } else if (existing) {
    // Container exists but is stopped — clear it before we start a
    // fresh boot. We do this regardless of the metadata because a
    // stopped container holds its name lock; docker run would fail
    // with "Conflict. The container name is already in use".
    await dockerRm(containerName);
  }

  // Ensure data + bind directories exist with the right ownership for
  // the container's `node` user (uid 1000 in node:22-alpine). Without
  // chown, the first write inside the container hits EACCES.
  //
  // Paths are resolved to absolute host paths because the tenants dir
  // is bound into the HM container at the SAME path (identical-path
  // bind mount — see the constants block at the top of this file).
  // A relative path would resolve differently on host vs inside the
  // container; absolute paths sidestep that.
  const absDataDir = path.resolve(dataDir);
  const walletDir   = path.join(absDataDir, 'manager-wallet');
  const stateDir    = path.join(absDataDir, 'state');
  const tenantsDir  = path.join(absDataDir, 'tenants');
  for (const dir of [walletDir, stateDir, tenantsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Chown is a separate step because mkdirSync inherits the calling
  // user's uid. We pass through `chown -R 1000:1000` via the docker
  // CLI so we don't need sudo locally. Suppress errors — on rootless
  // docker the mount uses uid mapping and chown isn't needed.
  await chownForContainer(walletDir, stateDir, tenantsDir);

  const templatesFile = ensureTemplatesFile(dataDir, config.templatesFile);

  // ── Drift-bootstrap loop ───────────────────────────────────────────
  // The agentic-hosting HM does two sequential checks on its wallet
  // identity vs the env-supplied values:
  //   1. MANAGER_PUBKEY        — fails first if pubkey differs
  //   2. MANAGER_DIRECT_ADDRESS — fails second if address differs
  //
  // Each failed boot reveals AT MOST one real value. With placeholder
  // values on boot 1 the pubkey check fails and we learn the real
  // pubkey. On boot 2 with the real pubkey but a (pubkey-derived) DA
  // the DA check fails and we learn the real DA. On boot 3 with both
  // real values the HM boots cleanly.
  //
  // Cap at 3 boots: that's the worst case in steady state. A 4th boot
  // means something else is wrong; surface to the operator.
  let currentPubkey = PLACEHOLDER_PUBKEY;
  let currentDirectAddress = PLACEHOLDER_DIRECT_ADDRESS;
  let realManagerPubkey: string | null = null;
  let realManagerDirectAddress: string | null = null;
  const maxBoots = 3;
  let bootNum = 0;
  let lastLogsForError = '';

  for (; bootNum < maxBoots; bootNum++) {
    const env = buildHmEnv({
      controllerPubkey: config.controllerPubkey,
      hostId,
      managerPubkey: currentPubkey,
      managerDirectAddress: currentDirectAddress,
      tenantsHostDir: tenantsDir,
      healthPort,
    });

    await dockerRunDetached({
      name: containerName,
      image,
      env,
      volumes: [
        { host: DOCKER_SOCKET, container: DOCKER_SOCKET },
        { host: templatesFile, container: HM_TEMPLATES_PATH_IN_CONTAINER, readonly: true },
        { host: walletDir,     container: HM_WALLET_PATH_IN_CONTAINER },
        { host: stateDir,      container: HM_STATE_PATH_IN_CONTAINER },
        // Identical-path bind for tenants — host path = container path.
        // The HM tells the docker daemon to bind-mount sub-paths into
        // each tenant; the daemon resolves them on the host, so both
        // sides MUST agree on the path. See the rationale comment on
        // the HM constants block at the top of this file.
        { host: tenantsDir,    container: tenantsDir },
      ],
      ports: [{ host: healthPort, container: 9401 }],
      groupAddDockerGid: detectDockerGid(),
    });

    // On the LAST attempt (boot 3 with both values known) use the full
    // ready timeout. Earlier attempts only need to wait long enough for
    // the drift error to surface, which happens in <2s after boot.
    const expectingReady = bootNum > 0 && realManagerPubkey !== null && realManagerDirectAddress !== null;
    const timeoutMs = expectingReady ? DEFAULT_READY_TIMEOUT_MS : BOOTSTRAP_LOG_TIMEOUT_MS;

    const result = await waitForBootSignal(containerName, timeoutMs);

    if (result.kind === 'timeout') {
      lastLogsForError = result.lastLogs;
      await dockerRm(containerName);
      throw new Error(
        `Local HM boot ${bootNum + 1}/${maxBoots} timed out after ${timeoutMs}ms. Tail of logs:\n${lastLogsForError.slice(-2000)}`,
      );
    }

    if (result.kind === 'ready') {
      // Success. If we didn't learn both values from drift errors
      // (e.g., boot 1 succeeded because the wallet directory's pubkey
      // happened to match the placeholder — rare but possible on a
      // reuse), pull them from the success log.
      if (realManagerPubkey === null || realManagerDirectAddress === null) {
        const liveInfo = parseManagerIdentityFromLogs(await readContainerLogs(containerName, 1000));
        if (!liveInfo) {
          await dockerRm(containerName);
          throw new Error(
            'Local HM boot succeeded but sphere-cli could not parse the manager identity from logs. ' +
              'Stop the container manually and re-run `sphere host local-spawn`.',
          );
        }
        realManagerPubkey = realManagerPubkey ?? liveInfo.managerPubkey;
        realManagerDirectAddress = realManagerDirectAddress ?? liveInfo.managerDirectAddress;
      }
      break;
    }

    // result.kind === 'drift' — extract whichever real value the error
    // revealed and prep for the next boot.
    if (result.managerPubkey) {
      realManagerPubkey = result.managerPubkey;
      currentPubkey = result.managerPubkey;
    }
    if (result.managerDirectAddress) {
      realManagerDirectAddress = result.managerDirectAddress;
      currentDirectAddress = result.managerDirectAddress;
    }

    // The HM exits after throwing — we have to docker rm before the
    // next attempt or docker run will conflict on the container name.
    await dockerRm(containerName);

    // Loop iterates and tries again with the updated env values.
  }

  if (bootNum === maxBoots) {
    throw new Error(
      `Local HM bootstrap exhausted ${maxBoots} attempts without reaching sphere_initialized. ` +
      `Last known state: pubkey=${realManagerPubkey ?? '(unknown)'}, ` +
      `directAddress=${realManagerDirectAddress ?? '(unknown)'}. ` +
      `Inspect docker logs ${containerName} for the underlying ConfigError.`,
    );
  }

  if (realManagerPubkey === null || realManagerDirectAddress === null) {
    throw new Error(
      'Local HM bootstrap completed but sphere-cli was unable to determine the manager identity. ' +
      'This is a sphere-cli bug; please file a report with the docker logs.',
    );
  }

  const meta: LocalHmMetadata = {
    controllerPubkey: config.controllerPubkey,
    managerPubkey: realManagerPubkey,
    managerDirectAddress: realManagerDirectAddress,
    managerNametag,
    hostId,
    containerName,
    image,
    healthPort,
    createdAt: new Date().toISOString(),
  };
  writeMetadata(dataDir, meta);
  return meta;
}

/**
 * Stop + remove the local HM container for a controller wallet.
 *
 * - `keepData: false` (default): leave the bind-mounted data dir
 *   intact. The wallet, state.json, tenant records all persist for
 *   next time. Setting `keepData: true` is currently a no-op (the
 *   data is preserved either way) and is reserved for a future
 *   `--purge-data` option.
 * - `keepContainer: true`: skip `docker rm` (only `docker stop`).
 *   Useful for `--keep-hm` semantics in `sphere trader stop`.
 */
export async function stopLocalHM(opts: {
  controllerPubkey: string;
  keepContainer?: boolean;
}): Promise<{ stopped: boolean; removed: boolean }> {
  const name = localHmContainerName(opts.controllerPubkey);
  const inspect = await inspectContainer(name);
  if (!inspect) {
    return { stopped: false, removed: false };
  }
  await dockerStop(name);
  if (opts.keepContainer === true) {
    return { stopped: true, removed: false };
  }
  await dockerRm(name);
  return { stopped: true, removed: true };
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Wait for the `sphere_initialized` log line. Used by the post-bootstrap
 * boot to confirm the HM is actually serving HMCP traffic before the
 * caller (`sphere trader spawn`) issues spawn requests against it.
 */
async function waitForReady(
  containerName: string,
  timeoutMs: number,
): Promise<{ ok: boolean; lastLogs: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastLogs = '';
  while (Date.now() < deadline) {
    lastLogs = await readContainerLogs(containerName, 500);
    if (lastLogs.includes(READY_LOG_MARKER)) {
      return { ok: true, lastLogs };
    }
    await new Promise((r) => setTimeout(r, READY_LOG_POLL_MS));
  }
  return { ok: false, lastLogs };
}

/**
 * After a successful boot, the HM logs a `sphere_initialized` line
 * carrying `direct_address` and `pubkey` (truncated). We use this to
 * recover the manager identity when the second-boot path isn't needed
 * (e.g., the bootstrap actually succeeded because the wallet already
 * matched our placeholder somehow — rare but possible if the operator
 * is recovering from a partial prior run).
 *
 * Returns null when the line isn't parseable (caller falls back to a
 * loud error message).
 */
function parseManagerIdentityFromLogs(
  logs: string,
): { managerPubkey: string; managerDirectAddress: string } | null {
  // Logger emits `sphere_initialized` with structured fields; the
  // formatting varies (JSON vs human) by LOG_FORMAT. Match the
  // `direct_address` field defensively against either.
  const directMatch = logs.match(/direct_address["':=\s]+(DIRECT:\/\/[0-9a-fA-F]+)/);
  if (!directMatch || !directMatch[1]) return null;
  const directAddress = directMatch[1];
  // Pubkey embedded in the DIRECT://<hex>. The HM's direct address
  // format prefixes a 12-char address-type tag before the pubkey, but
  // the trailing 66 hex chars are always the chain pubkey. We pull
  // those out for the metadata record so it's consistent with the
  // bootstrap path (which already has just the pubkey).
  const tail = directAddress.replace(/^DIRECT:\/\//, '');
  const last66 = tail.slice(-66);
  if (!/^[0-9a-fA-F]{66}$/.test(last66)) return null;
  return {
    managerPubkey: last66.toLowerCase(),
    managerDirectAddress: directAddress,
  };
}

/**
 * Ensure bind-mounted dirs are writable by the container's `node`
 * user (uid 1000 in node:22-alpine). Uses a throwaway alpine container
 * so we don't need `sudo chown` locally and the operation works the
 * same way whether the operator is rootful, rootless, or under
 * podman-compat.
 */
async function chownForContainer(...dirs: string[]): Promise<void> {
  if (dirs.length === 0) return;
  try {
    // Mount /target as a writable workspace, chown its top-level
    // children to 1000:1000. Quiet single shot — no need for
    // `--rm` since we use `--rm` directly.
    // We mount each dir individually because Docker doesn't accept
    // multiple --volume flags pointing at the same path.
    for (const dir of dirs) {
      await execFileAsync('docker', [
        'run', '--rm',
        '--volume', `${dir}:/target`,
        'alpine:3.20',
        'chown', '-R', '1000:1000', '/target',
      ]);
    }
  } catch {
    // Best-effort. If the user has correctly configured rootless
    // docker (or runs as uid 1000), this isn't needed. The HM will
    // surface a clear EACCES if it can't write.
  }
}
