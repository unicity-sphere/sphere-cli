/**
 * Shared helpers for sphere-cli integration tests against real infrastructure.
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SphereEnv {
  /** Absolute path of the throwaway profile dir (created fresh per test). */
  readonly home: string;
  /** Full env passed to the CLI — isolates profile + disables prompts. */
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Create an isolated sphere-cli profile rooted in a fresh tmp directory.
 * The CLI reads `./.sphere-cli/config.json` relative to cwd, so we set
 * cwd to the tmp home when invoking and pre-seed a testnet config.
 */
export function createSphereEnv(label: string): SphereEnv {
  const home = mkdtempSync(join(tmpdir(), `sphere-cli-it-${label}-`));
  const cfgDir = join(home, '.sphere-cli');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    join(cfgDir, 'config.json'),
    JSON.stringify({
      network: 'testnet',
      dataDir: join(home, '.sphere-cli'),
      tokensDir: join(home, '.sphere-cli', 'tokens'),
    }),
    'utf8',
  );
  return {
    home,
    env: {
      ...process.env,
      // Disable any interactive prompts / progress bars that the legacy CLI
      // might emit; we read stdout/stderr as plain strings.
      CI: '1',
      FORCE_COLOR: '0',
      // Use the documented placeholder so aggregator requests authenticate.
      // Tests that need their own key can override via the per-call env.
      UNICITY_API_KEY: process.env['UNICITY_API_KEY'] ?? '',
    },
  };
}

export function destroySphereEnv(env: SphereEnv): void {
  rmSync(env.home, { recursive: true, force: true });
}

/**
 * Invoke the built sphere CLI (bin/sphere.mjs) inside a given profile dir.
 *
 * Returns stdout/stderr/status for easy assertion. Timeouts are generous
 * because real testnet round-trips can take 5-30s.
 */
export function runSphere(env: SphereEnv, args: string[], opts?: { input?: string; timeoutMs?: number }): SpawnSyncReturns<string> {
  const binPath = join(process.cwd(), 'bin', 'sphere.mjs');
  return spawnSync('node', [binPath, ...args], {
    cwd: env.home,
    env: env.env,
    encoding: 'utf8',
    input: opts?.input,
    timeout: opts?.timeoutMs ?? 90_000,
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
