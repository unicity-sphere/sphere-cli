/**
 * Integration test: local crypto commands (no network).
 *
 * Proves the test harness can invoke the built CLI and parse its output.
 * No external infrastructure is touched — these are deterministic and fast,
 * but live in the integration suite because they exercise the full
 * bin/sphere.mjs → dist/index.js → legacy dispatcher path end-to-end.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSphereEnv, destroySphereEnv, runSphere, type SphereEnv } from './helpers.js';

describe('sphere-cli integration — crypto (local)', () => {
  let env: SphereEnv;

  beforeAll(() => { env = createSphereEnv('crypto'); });
  afterAll(() => { destroySphereEnv(env); });

  it('`sphere --version` prints a version string', () => {
    const r = runSphere(env, ['--version']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('`sphere crypto generate-key` emits a valid compressed secp256k1 pubkey + address', () => {
    const r = runSphere(env, ['crypto', 'generate-key']);
    expect(r.status).toBe(0);
    // Output shape verified in Phase 2 smoke test:
    //   Public Key: 03...
    //   Address: alpha1q...
    expect(r.stdout).toMatch(/Public Key:\s*0[23][0-9a-fA-F]{64}/);
    expect(r.stdout).toMatch(/Address:\s*alpha1[a-z0-9]+/);
    // Private key + WIF must NOT leak unless --unsafe-print is set
    expect(r.stdout).not.toMatch(/Private Key:\s*[0-9a-fA-F]{64}\b/);
  });

  it('`sphere util to-smallest` and `to-human` roundtrip through sphere-sdk formatters', () => {
    const toSmallest = runSphere(env, ['util', 'to-smallest', '1.5']);
    expect(toSmallest.status).toBe(0);
    // to-smallest may emit bigint literal form (e.g. "150000000n") — strip the
    // trailing 'n' before round-tripping through to-human.
    const smallest = toSmallest.stdout.trim().replace(/n$/, '');
    expect(smallest).toMatch(/^\d+$/);

    const toHuman = runSphere(env, ['util', 'to-human', smallest]);
    expect(toHuman.status).toBe(0);
    expect(toHuman.stdout.trim()).toBe('1.5');
  });
});
