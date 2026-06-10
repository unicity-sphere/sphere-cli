/**
 * `sphere trader spawn` / `sphere trader stop` orchestration.
 *
 * The wrapper chains two existing primitives:
 *   1. `ensureLocalHM` (host/local-hm.ts) — brings up an agentic-hosting
 *      HM container scoped to the operator's wallet
 *   2. HMCP `hm.spawn` / `hm.stop` over Sphere DMs against that local HM
 *
 * The point is to make `sphere wallet use alice && sphere trader spawn`
 * a single-command bring-up. Without this wrapper, the operator has to
 * hand-orchestrate the HM container, scrape its drift-guard error,
 * restart it with corrected env, then drive `sphere host spawn` against
 * it — see GitHub sphere-cli#48 for the long-form motivation.
 *
 * `sphere trader stop` is the inverse: drive `hm.stop` for the tenant,
 * then optionally tear down the local HM container if no other tenants
 * remain on it.
 */

import * as path from 'node:path';
import type { Sphere } from '@unicitylabs/sphere-sdk';
import {
  ensureLocalHM,
  localHmStatus,
  stopLocalHM,
  type LocalHmMetadata,
} from '../host/local-hm.js';
import { initSphere } from '../host/sphere-init.js';
import { createDmTransport, type DmTransport } from '../transport/dm-transport.js';
import { createHmcpRequest, type HmcpRequest, type HmcpResponse } from '../transport/hmcp-types.js';
import { TimeoutError, TransportError } from '../transport/errors.js';

// =============================================================================
// Types
// =============================================================================

export interface TraderSpawnOptions {
  /**
   * Desired tenant instance name. Defaults to `<wallet-nametag>-trader`
   * or `<wallet-prefix>-trader` if the wallet has no nametag.
   */
  readonly name?: string;
  /**
   * Trusted escrow addresses (`@nametag`, `DIRECT://hex`, or hex pubkey)
   * the trader will accept as deal counterparties. Empty array → only
   * the default escrow from sphere-sdk#456 (`@escrow-test-02`).
   */
  readonly trustedEscrows?: ReadonlyArray<string>;
  /** Override `TRADER_SCAN_INTERVAL_MS`. Default: 30000. */
  readonly scanIntervalMs?: number;
  /**
   * Override the trader image. By default the local HM uses whatever
   * `templates.json` specifies for the `trader-agent` template; this
   * flag injects an `image` override into the hm.spawn payload.
   *
   * NOTE: the agentic-hosting HM doesn't yet accept image overrides
   * over HMCP — this option is reserved for a follow-up issue. For now,
   * override via `--templates-file` at `sphere host local-spawn`.
   */
  readonly image?: string;
  /**
   * Test-fund spec passed via `TRADER_TEST_FUND` env. Format:
   * `"coinIdHex:amount,coinIdHex:amount"`. Triggers self-mint at
   * trader startup; pairs with `TRADER_FAULT_INJECTION_ALLOWED=1`
   * which is set automatically here.
   *
   * REFUSED on mainnet — test-fund minting only makes sense on
   * testnet/dev.
   */
  readonly testFund?: string;
  /**
   * How long to wait for the local HM to be ready AND the tenant
   * spawn to complete. Default: 180_000 (3 minutes).
   */
  readonly readyTimeoutMs?: number;
  /**
   * Override the per-controller local HM data dir (and so the
   * container scope). See `LocalHmConfig.baseDir`.
   */
  readonly baseDir?: string;
  /** Override the HM container image (see local-hm.ts DEFAULT_HM_IMAGE). */
  readonly hmImage?: string;
  /** Override `templates.json` mounted into the local HM. */
  readonly templatesFile?: string;
  /** Override the health-port host-side mapping for the local HM. */
  readonly healthPort?: number;
  /**
   * Sphere network for both wallet sanity-check and the test-fund gate.
   * Defaults to whatever the wallet's `Sphere` instance reports.
   */
  readonly network?: 'testnet' | 'mainnet' | 'dev';
}

export interface TraderSpawnResult {
  readonly instance_name: string;
  readonly instance_id: string;
  readonly tenant_pubkey: string;
  readonly tenant_direct_address: string;
  readonly tenant_nametag: string | null;
  readonly hm_container: string;
  readonly hm_manager_address: string;
  readonly trader_image_template: string;
}

export interface TraderStopOptions {
  readonly name?: string;
  /** Don't tear down the local HM even if no tenants remain. */
  readonly keepHm?: boolean;
  /** Per-controller local HM data dir override. */
  readonly baseDir?: string;
}

export interface TraderStopResult {
  readonly tenant_stopped: boolean;
  readonly tenant_name: string | null;
  readonly tenant_id: string | null;
  readonly hm_stopped: boolean;
  readonly hm_removed: boolean;
}

// =============================================================================
// Defaults / helpers
// =============================================================================

const DEFAULT_LOCAL_HM_BASE_DIR = './.sphere-cli/local-hm';
const DEFAULT_READY_TIMEOUT_MS = 180_000;
const DEFAULT_TEMPLATE_ID = 'trader-agent';

/**
 * Build the tenant instance name. Public so the unit tests can
 * exercise the wallet-nametag → prefix fallback without an actual
 * Sphere instance.
 */
export function deriveTenantName(
  walletNametag: string | undefined,
  chainPubkey: string,
  explicit: string | undefined,
): string {
  if (explicit && explicit.trim()) return explicit.trim();
  if (walletNametag && walletNametag.trim()) {
    return `${walletNametag.trim().toLowerCase()}-trader`;
  }
  return `${chainPubkey.slice(0, 12).toLowerCase()}-trader`;
}

/**
 * Build the trader-tenant env bag passed to `hm.spawn`. Mirrors
 * trader-service/test/e2e-live/helpers/tenant-fixture.ts:310-365
 * (`buildContainerEnv`) for the controller-facing fields:
 *
 * - `UNICITY_CONTROLLER_PUBKEY` so the trader's auth gate accepts
 *   DMs signed by our wallet
 * - `UNICITY_NETWORK` / `UNICITY_RELAYS` (relays inherited from HM's
 *   template defaults; we don't override unless asked)
 * - `UNICITY_TRUSTED_ESCROWS` / `TRADER_SCAN_INTERVAL_MS`
 * - Test-fund + fault-injection allow-flag for testnet self-mint
 *
 * Critically: we do NOT synthesize the ACP boot envelope
 * (UNICITY_MANAGER_PUBKEY, UNICITY_BOOT_TOKEN, UNICITY_INSTANCE_ID,
 * UNICITY_INSTANCE_NAME, UNICITY_TEMPLATE_ID) — the HM injects those
 * itself when it spawns the tenant container, because parseTenantConfig
 * reads them from the env the HM passes (`docker run -e ...`).
 *
 * Exported for unit tests.
 */
export function buildTraderEnv(opts: {
  readonly controllerPubkey: string;
  readonly trustedEscrows?: ReadonlyArray<string>;
  readonly scanIntervalMs?: number;
  readonly testFund?: string;
  readonly network?: string;
}): Record<string, string> {
  const env: Record<string, string> = {
    UNICITY_CONTROLLER_PUBKEY: opts.controllerPubkey,
  };
  if (opts.network) env['UNICITY_NETWORK'] = opts.network;
  if (opts.scanIntervalMs !== undefined) {
    env['TRADER_SCAN_INTERVAL_MS'] = String(opts.scanIntervalMs);
  }
  if (opts.trustedEscrows && opts.trustedEscrows.length > 0) {
    env['UNICITY_TRUSTED_ESCROWS'] = opts.trustedEscrows.join(',');
  }
  if (opts.testFund && opts.testFund.trim()) {
    // The trader's production guard requires TRADER_FAULT_INJECTION_ALLOWED=1
    // alongside TRADER_TEST_FUND to actually self-mint. Tie them
    // together at the wrapper layer so operators don't have to know.
    env['TRADER_TEST_FUND'] = opts.testFund.trim();
    env['TRADER_FAULT_INJECTION_ALLOWED'] = '1';
  }
  return env;
}

function resolveBaseDir(raw: string | undefined): string {
  if (raw && raw.trim()) return path.resolve(raw.trim());
  return path.resolve(DEFAULT_LOCAL_HM_BASE_DIR);
}

// =============================================================================
// Spawn lifecycle
// =============================================================================

/**
 * Bring up a local HM container (idempotent) and spawn a trader tenant
 * on it. Idempotent for an already-running tenant of the same name —
 * looks it up via hm.list and returns its address instead of attempting
 * a re-spawn that would fail with "instance name in use."
 *
 * Caller owns the Sphere lifecycle. This function returns once the
 * tenant is RUNNING and its address is known.
 */
export async function spawnTrader(opts: TraderSpawnOptions): Promise<TraderSpawnResult> {
  const sphere = await initSphere();
  try {
    const id = sphere.identity;
    if (!id) throw new Error('Wallet has no identity. Run `sphere wallet init` first.');

    // Network gate for --test-fund. Self-mint on mainnet would burn
    // real funds — refuse loudly here so the user catches the typo
    // before the trader image is even pulled.
    const network = opts.network ?? 'testnet';
    if (opts.testFund && network === 'mainnet') {
      throw new Error(
        '--test-fund is refused on mainnet. Self-mint funding is only meaningful on testnet/dev.',
      );
    }

    const baseDir = resolveBaseDir(opts.baseDir);

    // ── 1. Ensure local HM is up ──────────────────────────────────────
    const hmMeta = await ensureLocalHM({
      controllerPubkey: id.chainPubkey,
      baseDir,
      templatesFile: opts.templatesFile,
      image: opts.hmImage,
      healthPort: opts.healthPort,
    });

    // ── 2. Spawn (or look up existing) tenant ─────────────────────────
    const instanceName = deriveTenantName(id.nametag, id.chainPubkey, opts.name);
    const traderEnv = buildTraderEnv({
      controllerPubkey: id.chainPubkey,
      trustedEscrows: opts.trustedEscrows,
      scanIntervalMs: opts.scanIntervalMs,
      testFund: opts.testFund,
      network,
    });

    const result = await spawnOrAdoptTenant(sphere, hmMeta, {
      instance_name: instanceName,
      template_id: DEFAULT_TEMPLATE_ID,
      env: traderEnv,
    }, opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);

    return {
      ...result,
      hm_container: hmMeta.containerName,
      hm_manager_address: hmMeta.managerDirectAddress,
      trader_image_template: DEFAULT_TEMPLATE_ID,
    };
  } finally {
    await safeDestroy(sphere);
  }
}

/**
 * Stop a trader tenant by name, optionally tearing down the local HM
 * container if no other tenants remain on it.
 */
export async function stopTrader(opts: TraderStopOptions): Promise<TraderStopResult> {
  const sphere = await initSphere();
  try {
    const id = sphere.identity;
    if (!id) throw new Error('Wallet has no identity. Run `sphere wallet init` first.');

    const baseDir = resolveBaseDir(opts.baseDir);
    const status = await localHmStatus({ controllerPubkey: id.chainPubkey, baseDir });
    if (!status.running || !status.metadata) {
      // No HM means no tenants to stop. Surface a clear no-op result
      // rather than a confusing "manager not reachable" timeout.
      return { tenant_stopped: false, tenant_name: null, tenant_id: null, hm_stopped: false, hm_removed: false };
    }
    const meta = status.metadata;

    const tenantName = deriveTenantName(id.nametag, id.chainPubkey, opts.name);

    // ── 1. Locate the tenant and stop it (best-effort over HMCP) ──────
    const stopOutcome = await stopTenantBestEffort(sphere, meta, tenantName);

    // ── 2. Optionally tear down the local HM ──────────────────────────
    let hmStopped = false;
    let hmRemoved = false;
    if (opts.keepHm !== true) {
      const remaining = await listRunningTenantsBestEffort(sphere, meta);
      // We just stopped tenantName, so it should no longer count. The
      // HM may still be running other tenants (escrow, future ones).
      // Only tear down when this was the last tenant.
      const otherRunning = remaining.filter(
        (entry) => entry.instance_name !== tenantName && isLiveState(entry.state),
      );
      if (otherRunning.length === 0) {
        const r = await stopLocalHM({ controllerPubkey: id.chainPubkey });
        hmStopped = r.stopped;
        hmRemoved = r.removed;
      }
    }

    return {
      tenant_stopped: stopOutcome.stopped,
      tenant_name: stopOutcome.instance_name,
      tenant_id: stopOutcome.instance_id,
      hm_stopped: hmStopped,
      hm_removed: hmRemoved,
    };
  } finally {
    await safeDestroy(sphere);
  }
}

// =============================================================================
// HMCP plumbing — copied stylistically from host-commands.ts but kept
// internal so the public API is shaped around spawn/stop semantics.
// =============================================================================

interface AdoptedTenant {
  readonly instance_name: string;
  readonly instance_id: string;
  readonly tenant_pubkey: string;
  readonly tenant_direct_address: string;
  readonly tenant_nametag: string | null;
}

async function spawnOrAdoptTenant(
  sphere: Sphere,
  hmMeta: LocalHmMetadata,
  payload: { instance_name: string; template_id: string; env: Record<string, string> },
  readyTimeoutMs: number,
): Promise<AdoptedTenant> {
  const transport = createDmTransport(sphere.communications, {
    managerAddress: hmMeta.managerDirectAddress,
    timeoutMs: readyTimeoutMs,
  });
  try {
    // Idempotency check: if a tenant with this name is already RUNNING
    // on the HM, return its info instead of re-spawning. The HM rejects
    // duplicate-name spawn with INVALID_PARAMS (verified in
    // agentic_hosting/src/host-manager/instance-coordinator.ts); we'd
    // rather give the operator the right answer than surface that.
    const existing = await findRunningTenantByName(transport, payload.instance_name);
    if (existing) return existing;

    // Wrap the streaming send. The HM emits hm.spawn_ack first, then
    // either hm.spawn_ready or hm.spawn_failed.
    return await new Promise<AdoptedTenant>((resolve, reject) => {
      const req: HmcpRequest = createHmcpRequest('hm.spawn', payload as unknown as Record<string, unknown>);
      void transport.sendRequestStream(req, (res: HmcpResponse) => {
        if (res.type === 'hm.spawn_ready') {
          const p = res.payload as Record<string, unknown>;
          const tenantNametag =
            typeof p['tenant_nametag'] === 'string' ? p['tenant_nametag'] : null;
          if (
            typeof p['instance_id'] !== 'string' ||
            typeof p['instance_name'] !== 'string' ||
            typeof p['tenant_pubkey'] !== 'string' ||
            typeof p['tenant_direct_address'] !== 'string'
          ) {
            reject(new Error('hm.spawn_ready missing expected fields'));
            return true;
          }
          resolve({
            instance_id: p['instance_id'] as string,
            instance_name: p['instance_name'] as string,
            tenant_pubkey: p['tenant_pubkey'] as string,
            tenant_direct_address: p['tenant_direct_address'] as string,
            tenant_nametag: tenantNametag,
          });
          return true;
        }
        if (res.type === 'hm.spawn_failed') {
          const p = res.payload as Record<string, unknown>;
          const reason = typeof p['reason'] === 'string' ? p['reason'] : 'unknown reason';
          reject(new Error(`hm.spawn failed: ${reason}`));
          return true;
        }
        if (res.type === 'hm.error') {
          const p = res.payload as Record<string, unknown>;
          const msg = typeof p['message'] === 'string' ? p['message'] : 'HM rejected the spawn';
          reject(new Error(`hm.error: ${msg}`));
          return true;
        }
        // hm.spawn_ack — keep listening for the ready/failed.
        return false;
      }, readyTimeoutMs).catch((err) => reject(err));
    });
  } finally {
    await transport.dispose().catch(() => undefined);
  }
}

async function stopTenantBestEffort(
  sphere: Sphere,
  hmMeta: LocalHmMetadata,
  tenantName: string,
): Promise<{ stopped: boolean; instance_name: string | null; instance_id: string | null }> {
  const transport = createDmTransport(sphere.communications, {
    managerAddress: hmMeta.managerDirectAddress,
  });
  try {
    const req = createHmcpRequest('hm.stop', { instance_name: tenantName });
    const res = await transport.sendRequest(req);
    if (res.type === 'hm.stop_result') {
      const p = res.payload as Record<string, unknown>;
      return {
        stopped: true,
        instance_name: typeof p['instance_name'] === 'string' ? p['instance_name'] : tenantName,
        instance_id: typeof p['instance_id'] === 'string' ? p['instance_id'] : null,
      };
    }
    if (res.type === 'hm.error') {
      const p = res.payload as Record<string, unknown>;
      // "instance not found" is a legitimate no-op; surface it as
      // stopped:false without throwing so callers can still tear
      // down the HM if they want to.
      const code = typeof p['error_code'] === 'string' ? p['error_code'] : '';
      if (code === 'INSTANCE_NOT_FOUND' || code === 'NOT_FOUND') {
        return { stopped: false, instance_name: tenantName, instance_id: null };
      }
      throw new Error(`hm.stop rejected: ${typeof p['message'] === 'string' ? p['message'] : code}`);
    }
    // Unknown response type — be loud rather than silently misreport.
    throw new Error(`hm.stop returned unexpected response: ${res.type}`);
  } catch (err) {
    if (err instanceof TimeoutError) {
      // HM was up at the time of `localHmStatus` but didn't respond
      // to hm.stop. Treat the tenant as "stop attempted; result
      // unknown" — and let the HM tear-down proceed (the HM will
      // SIGTERM the container when it shuts down).
      return { stopped: false, instance_name: tenantName, instance_id: null };
    }
    if (err instanceof TransportError) {
      return { stopped: false, instance_name: tenantName, instance_id: null };
    }
    throw err;
  } finally {
    await transport.dispose().catch(() => undefined);
  }
}

interface InstanceListEntry {
  readonly instance_name: string;
  readonly state: string;
}

async function listRunningTenantsBestEffort(
  sphere: Sphere,
  hmMeta: LocalHmMetadata,
): Promise<InstanceListEntry[]> {
  const transport = createDmTransport(sphere.communications, {
    managerAddress: hmMeta.managerDirectAddress,
  });
  try {
    const res = await transport.sendRequest(createHmcpRequest('hm.list', {}));
    if (res.type !== 'hm.list_result') return [];
    const p = res.payload as Record<string, unknown>;
    const instances = Array.isArray(p['instances']) ? p['instances'] : [];
    const out: InstanceListEntry[] = [];
    for (const raw of instances) {
      if (typeof raw !== 'object' || raw === null) continue;
      const o = raw as Record<string, unknown>;
      const instance_name = typeof o['instance_name'] === 'string' ? o['instance_name'] : '';
      const state = typeof o['state'] === 'string' ? o['state'] : '';
      if (!instance_name) continue;
      out.push({ instance_name, state });
    }
    return out;
  } catch {
    return [];
  } finally {
    await transport.dispose().catch(() => undefined);
  }
}

async function findRunningTenantByName(
  transport: DmTransport,
  tenantName: string,
): Promise<AdoptedTenant | null> {
  let res: HmcpResponse;
  try {
    res = await transport.sendRequest(createHmcpRequest('hm.list', {}));
  } catch {
    // hm.list timing out is not a hard failure — we'll fall through
    // to a fresh spawn attempt.
    return null;
  }
  if (res.type !== 'hm.list_result') return null;
  const p = res.payload as Record<string, unknown>;
  const instances = Array.isArray(p['instances']) ? p['instances'] : [];
  for (const raw of instances) {
    if (typeof raw !== 'object' || raw === null) continue;
    const o = raw as Record<string, unknown>;
    if (o['instance_name'] !== tenantName) continue;
    const state = typeof o['state'] === 'string' ? o['state'] : '';
    if (!isLiveState(state)) continue;
    // Pull the tenant info from inspect — hm.list returns just summary
    // fields, missing tenant_direct_address.
    const inspect = await transport.sendRequest(
      createHmcpRequest('hm.inspect', { instance_name: tenantName }),
    );
    if (inspect.type !== 'hm.inspect_result') return null;
    const ip = inspect.payload as Record<string, unknown>;
    if (
      typeof ip['instance_id'] !== 'string' ||
      typeof ip['tenant_pubkey'] !== 'string' ||
      typeof ip['tenant_direct_address'] !== 'string'
    ) {
      return null;
    }
    return {
      instance_id: ip['instance_id'] as string,
      instance_name: tenantName,
      tenant_pubkey: ip['tenant_pubkey'] as string,
      tenant_direct_address: ip['tenant_direct_address'] as string,
      tenant_nametag: typeof ip['tenant_nametag'] === 'string' ? ip['tenant_nametag'] as string : null,
    };
  }
  return null;
}

/**
 * "Live" states for tenant adoption + reference-count-style HM
 * tear-down. CREATED + BOOTING are pre-running but reserved instance
 * slots — tearing down the HM under them would orphan the slot.
 * STOPPED + FAILED are terminal and don't count toward "still in use."
 *
 * Exported for unit tests; this is a small enum but it's load-bearing
 * for the keep-hm-alive decision.
 */
export function isLiveState(state: string): boolean {
  const s = state.toUpperCase();
  return s === 'CREATED' || s === 'BOOTING' || s === 'RUNNING';
}

async function safeDestroy(sphere: Sphere): Promise<void> {
  try { await sphere.destroy(); } catch (e) {
    if (process.env['DEBUG']) {
      process.stderr.write(`sphere-cli: sphere.destroy error: ${String(e)}\n`);
    }
  }
}
