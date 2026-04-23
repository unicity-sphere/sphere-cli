/**
 * Shared helpers for sphere-cli integration tests against real infrastructure.
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Absolute path to the built CLI binary. Resolved at module-load time
 * relative to this source file so `runSphere` works from any cwd.
 *
 * test/integration/helpers.ts  →  ../../bin/sphere.mjs
 */
const BIN_PATH = fileURLToPath(new URL('../../bin/sphere.mjs', import.meta.url));

/**
 * Tmp-dir prefix for our throwaway wallet profiles. Hoisted so the startup
 * sweep and per-test cleanup use the exact same token — any future rename
 * must happen in one place.
 */
const TMP_PREFIX = 'sphere-cli-it-';

/**
 * Env vars the spawned CLI actually needs. Everything else (AWS_*, GITHUB_TOKEN,
 * NPM_TOKEN, SSH_AUTH_SOCK, ...) is stripped so we don't leak CI secrets into
 * a child process that may log unknown env on error paths.
 */
const ENV_ALLOWLIST: readonly string[] = [
  'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL',
  'NODE_PATH', 'NODE_OPTIONS',
  'TMPDIR', 'TMP', 'TEMP',
];

export interface SphereEnv {
  /** Absolute path of the throwaway profile dir (created 0700 per-test). */
  readonly home: string;
  /** Full env passed to the CLI — isolates profile + disables prompts. */
  readonly env: NodeJS.ProcessEnv;
}

/**
 * One-time sweep of stale profile dirs from previous crashed runs. A
 * SIGKILL / CI watchdog between `mkdtempSync` and `destroySphereEnv` would
 * otherwise leak a testnet wallet's mnemonic + private key under `/tmp`
 * indefinitely. Scans `/tmp` at module load and removes any entry matching
 * the prefix whose mtime is > 1 hour old (the grace window covers concurrent
 * in-flight runs on shared CI).
 */
function sweepStaleTmpDirs(): void {
  const root = tmpdir();
  const cutoffMs = Date.now() - 60 * 60 * 1000;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;  // /tmp might not exist in a sandbox — best effort
  }
  for (const entry of entries) {
    if (!entry.startsWith(TMP_PREFIX)) continue;
    const fullPath = join(root, entry);
    try {
      const st = statSync(fullPath);
      if (st.mtimeMs < cutoffMs) {
        rmSync(fullPath, { recursive: true, force: true });
      }
    } catch { /* best effort */ }
  }
}
sweepStaleTmpDirs();

/**
 * Active SphereEnvs keyed by home path. Registered so the process-exit
 * handler can shred them even when a test is killed mid-execution.
 */
const activeEnvs = new Set<string>();

function shredAllActive(): void {
  for (const home of activeEnvs) {
    try { rmSync(home, { recursive: true, force: true }); }
    catch { /* best effort during shutdown */ }
  }
  activeEnvs.clear();
}

// Install cleanup handlers exactly once at module load. `exit` catches
// normal termination; `SIGINT`/`SIGTERM` catch Ctrl-C and CI watchdog
// kills; `uncaughtException`/`unhandledRejection` catch test-framework
// explosions that bypass `afterAll`.
process.once('exit', shredAllActive);
process.once('SIGINT', () => { shredAllActive(); process.exit(130); });
process.once('SIGTERM', () => { shredAllActive(); process.exit(143); });
process.once('uncaughtException', (err) => {
  shredAllActive();
  // eslint-disable-next-line no-console
  console.error('uncaughtException in integration tests:', err);
  process.exit(1);
});

/**
 * Create an isolated sphere-cli profile rooted in a fresh 0700 tmp directory.
 * The CLI reads `./.sphere-cli/config.json` relative to cwd, so we set
 * cwd to the tmp home when invoking and pre-seed a testnet config.
 */
export function createSphereEnv(label: string): SphereEnv {
  const home = mkdtempSync(join(tmpdir(), `${TMP_PREFIX}${label}-`));
  // Lock permissions to owner-only BEFORE writing anything. Testnet keys
  // are still secp256k1 material; don't leave a readable wallet on a
  // shared CI runner.
  chmodSync(home, 0o700);

  activeEnvs.add(home);

  const cfgDir = join(home, '.sphere-cli');
  mkdirSync(cfgDir, { recursive: true });
  chmodSync(cfgDir, 0o700);

  writeFileSync(
    join(cfgDir, 'config.json'),
    JSON.stringify({
      network: 'testnet',
      dataDir: join(home, '.sphere-cli'),
      tokensDir: join(home, '.sphere-cli', 'tokens'),
    }),
    'utf8',
  );

  // Build the allowlisted env. Anything the parent has but isn't on the
  // allowlist is dropped.
  const env: NodeJS.ProcessEnv = {
    CI: '1',
    FORCE_COLOR: '0',
  };
  for (const key of ENV_ALLOWLIST) {
    const v = process.env[key];
    if (typeof v === 'string') env[key] = v;
  }
  // Forward UNICITY_API_KEY if set; otherwise the aggregator falls back
  // to its public placeholder (see @unicitylabs/sphere-sdk constants).
  // This line is the only place an aggregator credential can reach the
  // spawned CLI — no other var from process.env is forwarded.
  if (typeof process.env['UNICITY_API_KEY'] === 'string') {
    env['UNICITY_API_KEY'] = process.env['UNICITY_API_KEY'];
  }

  return { home, env };
}

export function destroySphereEnv(env: SphereEnv): void {
  rmSync(env.home, { recursive: true, force: true });
  activeEnvs.delete(env.home);
}

/**
 * Invoke the built sphere CLI (bin/sphere.mjs) inside a given profile dir.
 *
 * Returns stdout/stderr/status for easy assertion. Uses SIGKILL on timeout
 * so a hung child holding Nostr WebSocket connections or an open IPFS fetch
 * cannot delay the test runner past the declared budget.
 */
export function runSphere(
  env: SphereEnv,
  args: string[],
  opts?: { input?: string; timeoutMs?: number },
): SpawnSyncReturns<string> {
  return spawnSync('node', [BIN_PATH, ...args], {
    cwd: env.home,
    env: env.env,
    encoding: 'utf8',
    input: opts?.input,
    timeout: opts?.timeoutMs ?? 90_000,
    killSignal: 'SIGKILL',
  });
}

/** Public testnet infrastructure endpoints, verified in the Sphere SDK constants. */
export const PUBLIC_TESTNET = {
  nostrRelay: 'wss://nostr-relay.testnet.unicity.network',
  aggregator: 'https://goggregator-test.unicity.network',
  ipfsGateway: 'https://unicity-ipfs1.dyndns.org',
} as const;

/**
 * Skip the suite if the environment indicates network access is unavailable.
 * Allows CI to opt out via `SKIP_INTEGRATION=1`.
 */
export const integrationSkip = process.env['SKIP_INTEGRATION'] === '1';

// `dirname` is used in places below; alias to silence unused-import if
// tsup tree-shakes it inconsistently.
void dirname;
