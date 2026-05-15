/**
 * Local Nostr relay lifecycle for sphere-cli swap e2e tests.
 *
 * Wraps `docker compose up/down` for
 * test/integration/local-infra/docker-compose.yml. The relay container
 * exposes 127.0.0.1:7778 — a fresh SQLite event log is created in the
 * named volume on first boot; subsequent runs reuse the volume unless
 * the caller explicitly requests `wipe: true` (passes `-v` to compose
 * down to drop persisted state).
 *
 * The compose file is the source of truth for the image pin; this
 * helper is intentionally thin so version bumps don't drift between
 * two places.
 *
 * Source: ported from
 * /home/vrogojin/trader-service/test/e2e-live/local-infra/relay.ts.
 *
 * @module test/integration/local-infra/relay
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPOSE_FILE = join(__dirname, 'docker-compose.yml');

/** URL the relay listens on for host clients (matches docker-compose port). */
export const LOCAL_RELAY_URL = 'ws://127.0.0.1:7778';

/** HTTP probe URL — NIP-11 info doc served by the same handler. */
const LOCAL_RELAY_HTTP = 'http://127.0.0.1:7778';

/**
 * Discover the Docker bridge gateway IP (typically 172.17.0.1 on Linux
 * Docker). Spawned tenant containers can NOT reach the host's loopback
 * interface; they reach the host via this bridge IP.
 *
 * Returns the WebSocket URL containers should use for UNICITY_RELAYS.
 * Falls back to `host.docker.internal` if `docker network inspect` fails
 * (Docker Desktop on macOS/Windows resolves this automatically; recent
 * Linux Docker supports it via the `--add-host=host.docker.internal:host-gateway`
 * flag, which we set on `runContainer` calls).
 */
export function getLocalRelayUrlForContainers(): string {
  const out = spawnSync(
    'docker',
    ['network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}'],
    { encoding: 'utf8', timeout: 5_000 },
  );
  if (out.status === 0) {
    const gateway = out.stdout.trim();
    if (gateway.length > 0 && /^\d+\.\d+\.\d+\.\d+$/.test(gateway)) {
      return `ws://${gateway}:7778`;
    }
  }
  return 'ws://host.docker.internal:7778';
}

export interface RelayBootOptions {
  /**
   * Drop the persisted SQLite event log before booting (passes `-v` to
   * compose down). Default false — preserves the log so a developer can
   * sqlite3-inspect a failing test.
   */
  readonly wipe?: boolean;
  /** Total deadline for the relay to come up. Default 60s. */
  readonly timeoutMs?: number;
  /** Optional prefix for log lines so multi-stack output is greppable. */
  readonly logPrefix?: string;
}

export interface RelayHandle {
  /** WebSocket URL clients connect to. */
  readonly url: string;
  /** Container name (matches compose `container_name`). */
  readonly containerName: string;
  /** Stop + remove the relay container. Idempotent. */
  stop(opts?: { wipe?: boolean }): Promise<void>;
}

const log = (prefix: string, msg: string): void => {
  // eslint-disable-next-line no-console
  console.log(`${prefix}${msg}`);
};

/**
 * Run `docker compose -f <file> up -d relay` and wait for the NIP-11
 * info doc to respond 200. Returns a handle whose `stop()` runs `compose
 * down`.
 *
 * Throws if Docker isn't available, the image can't be pulled, or the
 * relay never becomes healthy within the timeout. We deliberately do not
 * swallow these errors — silent boot failures produce confusing failures
 * 30s deep into the test run.
 */
export async function bootLocalRelay(opts: RelayBootOptions = {}): Promise<RelayHandle> {
  const prefix = opts.logPrefix ?? '[swap-relay] ';
  const timeoutMs = opts.timeoutMs ?? 60_000;

  // 1. Sanity check: docker CLI present.
  const dockerVersion = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
  });
  if (dockerVersion.status !== 0) {
    throw new Error(
      `docker is not available (exit ${dockerVersion.status}): ${dockerVersion.stderr || dockerVersion.stdout}. ` +
        'Install Docker or unset E2E_RUN_SWAP to skip the e2e swap suite.',
    );
  }

  // 2. Optional: wipe persisted state.
  if (opts.wipe) {
    log(prefix, 'wiping previous relay-data volume…');
    spawnSync('docker', ['compose', '-f', COMPOSE_FILE, 'down', '-v'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
  }

  // 3. Boot.
  log(prefix, `booting relay container from ${COMPOSE_FILE}…`);
  const up = spawnSync('docker', ['compose', '-f', COMPOSE_FILE, 'up', '-d', 'relay'], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (up.status !== 0) {
    throw new Error(
      `docker compose up failed (exit ${up.status}):\nstdout: ${up.stdout}\nstderr: ${up.stderr}`,
    );
  }

  // 4. Wait for NIP-11 info doc.
  const deadline = Date.now() + timeoutMs;
  let lastError: string | null = null;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(LOCAL_RELAY_HTTP, {
        headers: { Accept: 'application/nostr+json' },
        signal: AbortSignal.timeout(2_000),
      });
      if (resp.ok) {
        const info = (await resp.json()) as { name?: string; software?: string; version?: string };
        log(prefix, `relay healthy: ${info.software ?? '?'} ${info.version ?? '?'} on ${LOCAL_RELAY_URL}`);
        return {
          url: LOCAL_RELAY_URL,
          containerName: 'sphere-cli-swap-relay',
          stop: async (stopOpts) => stopRelay(prefix, stopOpts?.wipe ?? false),
        };
      }
      lastError = `HTTP ${resp.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }

  // Boot failed — capture container logs for actionable diagnosis.
  const logs = spawnSync('docker', ['logs', 'sphere-cli-swap-relay', '--tail', '50'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  await stopRelay(prefix, /* wipe */ false);
  throw new Error(
    `local relay never became healthy within ${timeoutMs}ms (last error: ${lastError ?? 'unknown'}).\n` +
      `--- container logs (last 50 lines) ---\n${logs.stdout || logs.stderr || '(empty)'}`,
  );
}

async function stopRelay(prefix: string, wipe: boolean): Promise<void> {
  const args = ['compose', '-f', COMPOSE_FILE, 'down'];
  if (wipe) args.push('-v');
  log(prefix, `stopping relay (wipe=${wipe})…`);
  spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000 });
}
