/**
 * Escrow container lifecycle for sphere-cli swap e2e tests.
 *
 * Spawns the agentic-hosting escrow image directly via `docker run` — no
 * host-manager (HMA), no template registry. Used by the swap CLI e2e
 * suite to materialize a real escrow service that alice/bob can address
 * via `--escrow <addr>` on `sphere swap propose`.
 *
 * Source: ported from
 * /home/vrogojin/trader-service/test/e2e-live/helpers/tenant-fixture.ts
 * (provisionEscrow), simplified for the no-HMA case.
 *
 * Trade-offs vs the trader-service version:
 *   - No controller-wallet binding (swap doesn't need trader-ctl auth).
 *   - No host-manager pubkey (synthesized random secp256k1 placeholder).
 *   - Single image pin, single-relay configuration.
 *
 * @module test/integration/local-infra/escrow
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

/**
 * Image pin — defaults to `ghcr.io/vrogojin/agentic-hosting/escrow:v0.3`,
 * published 2026-05-20 against the uxf `integration/all-fixes` HEAD
 * (commit af3c0a101f2a6f7f3bccff42b974e7b26148ee73). Publicly pullable;
 * digest `sha256:0fe3f926320c7200806b7231b6c76dfd26896f829144a919581afef227a88219`.
 *
 * Composition (vs v0.2):
 *   - escrow-service: master (no source changes; only SPHERE_SDK_SHA bump)
 *   - sphere-sdk: uxf integration/all-fixes @af3c0a1, picking up:
 *       * PR #196 (issue #195 fix) — unblocks recipient finalization for
 *         inbound deposits by (a) removing the placeholder manifest entry
 *         in the recipient poll callback (eliminates the cas-mismatch on
 *         every finalization) and (b) emitting `transfer:confirmed` from
 *         the recipient dispositionWriter so AccountingModule re-fires
 *         `invoice:covered` with `confirmed: true`. Verified end-to-end:
 *         `E2E_RUN_SWAP_FULL=1` full settlement completes in ~130s vs
 *         600s budget; v0.2 hung at PARTIAL_DEPOSIT indefinitely.
 *       * All upstream content from v0.2 (PR #105, #115, #119, #128,
 *         #146/147/149/152, payments/* faucet-flow regression fixes).
 *
 * Composition (vs v0.1):
 *   - escrow-service: master + `fix/conservative-payout-mode` HEAD
 *     (4 commits ahead of v0.1: conservative payout transferMode,
 *     UNICITY_NOSTR_RELAYS env override, deliverDepositInvoice
 *     instrumentation, BUG-001 docstring cleanup)
 *
 * v0.1 (`ghcr.io/vrogojin/agentic-hosting/escrow:v0.1`, 2026-04-25)
 * and v0.2 (2026-05-16) are STALE for full-settlement testing —
 * v0.2 specifically hangs at PARTIAL_DEPOSIT (issue #195). The
 * trader-service harness still pins v0.1 as of 2026-05-16; that
 * coordination is tracked separately.
 *
 * Override via `SPHERE_CLI_ESCROW_IMAGE=<tag>` env var to test against
 * a different escrow tag — e.g. a locally-built dev image:
 *
 *   # Build a local image against current source trees:
 *   mkdir /tmp/escrow-uxf-build && cd /tmp/escrow-uxf-build
 *   rsync -a --exclude=node_modules --exclude=dist --exclude=.git \
 *     /home/vrogojin/escrow-service/ ./escrow-service/
 *   rsync -a --exclude=node_modules --exclude=dist --exclude=.git \
 *     --exclude=tests --exclude=.claude --exclude=docs --exclude=examples \
 *     /home/vrogojin/uxf/ ./sphere-sdk/
 *   docker build -f escrow-service/Dockerfile -t escrow:local-uxf .
 *   SPHERE_CLI_ESCROW_IMAGE=escrow:local-uxf E2E_RUN_SWAP=1 npm run test:integration
 */
export const ESCROW_IMAGE =
  process.env['SPHERE_CLI_ESCROW_IMAGE'] ?? 'ghcr.io/vrogojin/agentic-hosting/escrow:v0.3';

const DEFAULT_READY_TIMEOUT_MS = 120_000;

export interface EscrowBootOptions {
  /**
   * Container-reachable Nostr relay URL. Use `getLocalRelayUrlForContainers()`
   * from relay.ts to derive the docker-bridge-gateway URL when running
   * against the local relay; pass a public testnet relay URL if you want
   * the escrow to participate in testnet broadcasts.
   */
  readonly relayUrl: string;
  /** L3 network (default 'testnet'). */
  readonly network?: 'testnet' | 'mainnet';
  /** Deadline for the escrow to log `sphere_initialized`. Default 120s. */
  readonly readyTimeoutMs?: number;
  /** Optional prefix for log lines so multi-stack output is greppable. */
  readonly logPrefix?: string;
  /**
   * Container name override. Defaults to a UUID-suffixed name so multiple
   * tests / concurrent runs don't collide. Mostly useful in interactive
   * debugging when you want a predictable `docker logs` target.
   */
  readonly containerName?: string;
}

export interface EscrowHandle {
  /** Docker container ID (full SHA). */
  readonly containerId: string;
  /** Container name (matches `--name` flag). */
  readonly containerName: string;
  /** Escrow on-the-wire address (DIRECT://hex or @nametag). */
  readonly address: string;
  /** Stop + remove the container. Idempotent. */
  stop(): Promise<void>;
}

const log = (prefix: string, msg: string): void => {
  // eslint-disable-next-line no-console
  console.log(`${prefix}${msg}`);
};

/**
 * Generate a real, on-curve secp256k1 compressed pubkey hex string.
 *
 * The escrow image's startup performs actual EC point validation (not
 * just regex shape) for env-supplied pubkeys; random hex with `0x02`
 * prefix has ~50% probability of NOT being on the curve. We use
 * sphere-sdk's published `getPublicKey` to derive a pubkey from a
 * random 32-byte private key, matching exactly what the trader-service
 * harness does (consistency across both test stacks).
 *
 * The private key is discarded immediately; we never sign as
 * "manager" or "controller" — these are placeholder pubkeys to satisfy
 * the escrow's boot-envelope schema.
 */
async function realSecp256k1Pubkey(): Promise<string> {
  // Dynamic import keeps the SDK out of the offline tier's load path.
  // The offline cli-swap tests don't need to touch sphere-sdk at all.
  const { getPublicKey } = await import('@unicitylabs/sphere-sdk');
  const sk = randomBytes(32).toString('hex');
  return getPublicKey(sk);
}

/**
 * Materialize a host-side wallet directory (data + tokens subdirs) for
 * the escrow's bind mount. The escrow's `Sphere.init` generates the
 * actual keypair inside the container on first boot.
 *
 * Permissions: locked to owner-only (0700) immediately after creation.
 * POSIX mkdtemp(3) creates with mode 0700 already; the explicit chmod
 * is paranoia for non-POSIX platforms (Windows) where Node's emulation
 * may inherit DACLs from the parent. Matches the hardening pattern in
 * `helpers.ts:createSphereEnv`.
 */
function materializeWalletDir(label: string): string {
  const safeLabel = label.replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 24);
  const root = mkdtempSync(join(tmpdir(), `sphere-cli-swap-${safeLabel}-`));
  chmodSync(root, 0o700);
  mkdirSync(join(root, 'wallet'), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'tokens'), { recursive: true, mode: 0o700 });
  return root;
}

/**
 * Run `docker run -d` for the escrow image with the env bag wired up,
 * then poll the container's stdout for the `sphere_initialized` log
 * line and extract the escrow's `direct_address`.
 *
 * On any failure (image pull error, container exits, boot timeout)
 * captures the container logs and tears the container down before
 * throwing.
 */
export async function bootEscrow(opts: EscrowBootOptions): Promise<EscrowHandle> {
  const prefix = opts.logPrefix ?? '[swap-escrow] ';
  const network = opts.network ?? 'testnet';
  const timeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const containerName = opts.containerName ?? `sphere-cli-swap-escrow-${randomUUID().slice(0, 8)}`;

  // 1. Sanity check: docker CLI present.
  const dockerVersion = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
  });
  if (dockerVersion.status !== 0) {
    throw new Error(
      `docker is not available (exit ${dockerVersion.status}): ${dockerVersion.stderr || dockerVersion.stdout}.`,
    );
  }

  const managerPubkey = await realSecp256k1Pubkey();
  const controllerPubkey = await realSecp256k1Pubkey();
  const instanceId = `swap-e2e-${randomUUID()}`;

  let walletDir: string | null = null;
  let containerId: string | null = null;

  try {
    // 2. Wallet dir on host (bound RW into the container).
    walletDir = materializeWalletDir('escrow');

    // 3. Compose the `docker run` argv. The agentic-hosting escrow image
    // expects the ACP boot envelope + Sphere runtime config.
    //
    // Relay env var name: the escrow's acp-adapter reads
    // `UNICITY_NOSTR_RELAYS` (with `SPHERE_NOSTR_RELAYS` as fallback).
    // Earlier drafts used `UNICITY_RELAYS` which the escrow silently
    // ignored — the container then fell back to network-default relays.
    // That worked accidentally only because the e2e suite already
    // targets the public testnet relay; pointing this helper at a local
    // Nostr relay would have failed silently.
    //
    // Manager direct address: must be a `DIRECT://...` form, not a raw
    // pubkey hex. The current escrow code only checks that the env var
    // is non-empty, but a future routing change would dereference it as
    // a transport address — synthesize a syntactically correct
    // placeholder so a future protocol update doesn't silently degrade.
    const env: Record<string, string> = {
      UNICITY_MANAGER_PUBKEY: managerPubkey,
      UNICITY_MANAGER_DIRECT_ADDRESS: `DIRECT://${managerPubkey}`,
      UNICITY_CONTROLLER_PUBKEY: controllerPubkey,
      UNICITY_BOOT_TOKEN: randomUUID(),
      UNICITY_INSTANCE_ID: instanceId,
      UNICITY_INSTANCE_NAME: containerName,
      UNICITY_TEMPLATE_ID: 'escrow',
      UNICITY_NETWORK: network,
      UNICITY_NOSTR_RELAYS: opts.relayUrl,
      UNICITY_DATA_DIR: '/data/wallet',
      UNICITY_TOKENS_DIR: '/data/tokens',
      LOG_LEVEL: 'info',
    };

    const runArgs = [
      'run', '-d',
      '--name', containerName,
      // Detached host-gateway extra-host: allows the container to reach
      // the host via host.docker.internal regardless of the bridge IP.
      // We pass the gateway-IP form via UNICITY_NOSTR_RELAYS anyway, but
      // this covers the host.docker.internal fallback path.
      '--add-host', 'host.docker.internal:host-gateway',
      '-v', `${walletDir}/wallet:/data/wallet`,
      '-v', `${walletDir}/tokens:/data/tokens`,
    ];
    for (const [k, v] of Object.entries(env)) {
      runArgs.push('-e', `${k}=${v}`);
    }
    runArgs.push(ESCROW_IMAGE);

    log(prefix, `starting escrow container ${containerName}…`);
    const run = spawnSync('docker', runArgs, { encoding: 'utf8', timeout: 120_000 });
    if (run.status !== 0) {
      throw new Error(
        `docker run escrow failed (exit ${run.status}):\nstdout: ${run.stdout}\nstderr: ${run.stderr}`,
      );
    }
    containerId = run.stdout.trim();
    if (!containerId) {
      throw new Error(`docker run returned empty container id. stderr: ${run.stderr}`);
    }

    // 4. Wait for `sphere_initialized` event in logs. The escrow uses
    // pino: `{ msg: 'sphere_initialized', direct_address: 'DIRECT://...' }`.
    const address = await waitForReadyAddress(containerId, { timeoutMs, prefix });
    log(prefix, `escrow ready at ${address}`);

    return {
      containerId,
      containerName,
      address,
      stop: async () => stopEscrow(prefix, containerId!, walletDir),
    };
  } catch (err) {
    // Capture logs BEFORE cleanup so the operator can post-mortem the
    // failure. Print to stderr — vitest captures it into the test output.
    if (containerId) {
      const logs = spawnSync('docker', ['logs', containerId, '--tail', '200'], {
        encoding: 'utf8',
        timeout: 5_000,
      });
      process.stderr.write(
        `\n=== ESCROW BOOT FAILED — container logs (last 200) ===\n` +
        `${logs.stdout || logs.stderr || '(empty)'}\n=== END ESCROW LOGS ===\n`,
      );
    }
    await stopEscrow(prefix, containerId, walletDir).catch(() => { /* best effort */ });
    throw err;
  }
}

/**
 * Poll container logs until a JSON event line carries either
 *   `{ msg: 'sphere_initialized', direct_address: 'DIRECT://...' }`     (pino)
 *   `{ event: 'sphere_initialized', details: { agent_address: '@x' } }` (custom)
 *
 * Returns the resolved address.
 */
async function waitForReadyAddress(
  containerId: string,
  opts: { timeoutMs: number; intervalMs?: number; prefix: string },
): Promise<string> {
  const intervalMs = opts.intervalMs ?? 1_500;
  const deadline = Date.now() + opts.timeoutMs;
  let lastSnippet = '';

  while (Date.now() < deadline) {
    const r = spawnSync('docker', ['logs', containerId, '--tail', '500'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    const logs = (r.stdout ?? '') + '\n' + (r.stderr ?? '');
    lastSnippet = logs.slice(-1500);
    for (const line of logs.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed[0] !== '{') continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      // pino shape (escrow image's logger of choice)
      if (parsed['msg'] === 'sphere_initialized') {
        const addr = parsed['direct_address'];
        if (typeof addr === 'string' && addr !== '') return addr;
      }
      // custom JSON shape (trader-style)
      if (parsed['event'] === 'sphere_initialized') {
        const details = parsed['details'];
        if (typeof details === 'object' && details !== null) {
          const addr = (details as Record<string, unknown>)['agent_address'];
          if (typeof addr === 'string' && addr !== '') return addr;
        }
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `escrow container ${containerId} did not log sphere_initialized within ${opts.timeoutMs}ms.\n` +
    `--- last log snippet ---\n${lastSnippet}\n--- end ---`,
  );
}

async function stopEscrow(
  prefix: string,
  containerId: string | null,
  walletDir: string | null,
): Promise<void> {
  if (containerId !== null) {
    log(prefix, `stopping container ${containerId.slice(0, 12)}…`);
    spawnSync('docker', ['stop', containerId], { encoding: 'utf8', timeout: 30_000 });
    spawnSync('docker', ['rm', '-f', containerId], { encoding: 'utf8', timeout: 10_000 });
  }
  if (walletDir !== null) {
    try { rmSync(walletDir, { recursive: true, force: true }); }
    catch { /* best effort */ }
  }
}
