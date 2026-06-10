/**
 * Pure-function tests for the local-HM helpers. The actual docker
 * interaction is intentionally NOT covered here — it requires a docker
 * daemon + several GB of agentic-hosting + trader images, and goes
 * under the e2e smoke that ships with `npm run test:integration`.
 *
 * What's covered here:
 *   - walletPrefix, deriveHostId, deriveManagerNametag, deriveHealthPort
 *     (deterministic derivations from controller pubkey)
 *   - parseDriftError (parsing the HM's drift-guard error message)
 *   - buildHmEnv (HM env-bag synthesis — drives container startup)
 *   - ensureTemplatesFile (bundled-template write + custom-source copy)
 *   - readMetadata / writeMetadata roundtrip
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  walletPrefix,
  deriveHostId,
  deriveManagerNametag,
  deriveHealthPort,
  parseDriftError,
  buildHmEnv,
  ensureTemplatesFile,
  readMetadata,
  localHmDataDir,
  localHmContainerName,
  DEFAULT_TEMPLATES,
} from './local-hm.js';

describe('walletPrefix', () => {
  it('returns the first 12 chars lowercased', () => {
    expect(walletPrefix('0398e7df0a4580f59ceeb06bd13102d8c6e1e899058959e4dd4602ae4c0e08098a'))
      .toBe('0398e7df0a45');
  });

  it('handles uppercase input', () => {
    expect(walletPrefix('0398E7DF0A4580F59CEEB06BD13102D8C6E1E899'))
      .toBe('0398e7df0a45');
  });

  it('throws when input is shorter than 12 chars', () => {
    expect(() => walletPrefix('abc')).toThrow(/too short/);
  });
});

describe('deriveHostId', () => {
  it('prefixes the wallet prefix with `u-`', () => {
    expect(deriveHostId('0398e7df0a4580f59ceeb06bd13102d8c6e1e89905'))
      .toBe('u-0398e7df0a45');
  });

  it('produces a HOST_ID that matches agentic_hosting HOST_ID_RE', () => {
    // From agentic_hosting/src/shared/config.ts:21
    const HOST_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
    const id = deriveHostId('abcdef0123456789abcdef0123456789abcdef01');
    expect(HOST_ID_RE.test(id)).toBe(true);
  });
});

describe('deriveManagerNametag', () => {
  it('mirrors agentic_hosting host-manager/main.ts:467 formula', () => {
    // Strip non-alphanumeric, lowercase, max 12 chars, prefix with `m-`.
    expect(deriveManagerNametag('u-0398e7df0a45')).toBe('m-u0398e7df0a4');
    expect(deriveManagerNametag('swap-soak')).toBe('m-swapsoak');
    // Truncates at 12 chars before adding the `m-` prefix.
    expect(deriveManagerNametag('thisisaverylongthing')).toBe('m-thisisaveryl');
  });
});

describe('deriveHealthPort', () => {
  it('returns a port in [9401, 9401+1023]', () => {
    const p = deriveHealthPort('abcdef01234567890');
    expect(p).toBeGreaterThanOrEqual(9401);
    expect(p).toBeLessThanOrEqual(9401 + 1023);
  });

  it('is deterministic for the same pubkey', () => {
    const a = deriveHealthPort('0398e7df0a4580f5');
    const b = deriveHealthPort('0398e7df0a4580f5');
    expect(a).toBe(b);
  });

  it('produces different ports for different wallets', () => {
    // 5 hex chars give 2^20 buckets; collisions are possible but the
    // odds for these two specific values are zero. If this fails after
    // the formula changes, pick two different inputs.
    const alice = deriveHealthPort('0398e7df0a45');
    const bob = deriveHealthPort('02ab558ab81a');
    expect(alice).not.toBe(bob);
  });
});

describe('localHmContainerName', () => {
  it('uses the sphere-hm- prefix + wallet prefix', () => {
    expect(localHmContainerName('0398e7df0a4580f59ceeb06bd13102d8c6e1e899'))
      .toBe('sphere-hm-0398e7df0a45');
  });
});

describe('localHmDataDir', () => {
  it('joins base + wallet prefix', () => {
    expect(localHmDataDir('/tmp/x', '0398e7df0a4580f59ceeb06bd13102d8c6e1e899'))
      .toBe('/tmp/x/0398e7df0a45');
  });
});

describe('parseDriftError', () => {
  it('returns null when the marker is absent', () => {
    expect(parseDriftError('container started\nlogging stuff')).toBeNull();
  });

  it('returns null when the marker is present but no wallet= match', () => {
    // Marker without a wallet= field — can't extract the real pubkey.
    expect(parseDriftError('Error: MANAGER_PUBKEY mismatch: env="abc"')).toBeNull();
  });

  it('extracts the real pubkey from the drift-guard message', () => {
    const msg =
      'Error: MANAGER_PUBKEY mismatch: env="placeholderxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", ' +
      'wallet="02ab558ab81a2343beeed5fe95b159d3ed2a65ed51d7aaa7dcf92bc7ed35bcaafc". ' +
      'The wallet at ... does not match';
    const got = parseDriftError(msg);
    expect(got).not.toBeNull();
    expect(got?.managerPubkey).toBe('02ab558ab81a2343beeed5fe95b159d3ed2a65ed51d7aaa7dcf92bc7ed35bcaafc');
    expect(got?.managerDirectAddress).toBe(
      'DIRECT://02ab558ab81a2343beeed5fe95b159d3ed2a65ed51d7aaa7dcf92bc7ed35bcaafc',
    );
  });

  it('lowercases the extracted pubkey', () => {
    const msg =
      'MANAGER_PUBKEY mismatch: env="x", ' +
      'wallet="02AB558AB81A2343BEEED5FE95B159D3ED2A65ED51D7AAA7DCF92BC7ED35BCAAFC".';
    const got = parseDriftError(msg);
    expect(got?.managerPubkey).toBe('02ab558ab81a2343beeed5fe95b159d3ed2a65ed51d7aaa7dcf92bc7ed35bcaafc');
  });
});

describe('buildHmEnv', () => {
  it('produces the required HM env keys', () => {
    const env = buildHmEnv({
      controllerPubkey: '02ab',
      hostId: 'u-test',
      managerPubkey: '0279...',
      managerDirectAddress: 'DIRECT://0279...',
      healthPort: 9501,
    });
    expect(env).toMatchObject({
      HOST_ID: 'u-test',
      AUTHORIZED_CONTROLLERS: '02ab',
      MANAGER_PUBKEY: '0279...',
      MANAGER_DIRECT_ADDRESS: 'DIRECT://0279...',
      UNICITY_HEALTH_PORT: '9501',
      UNICITY_NETWORK: 'testnet',
      LOG_LEVEL: 'info',
    });
  });

  it('honours --network override', () => {
    const env = buildHmEnv({
      controllerPubkey: '02ab',
      hostId: 'u-test',
      managerPubkey: '0279...',
      managerDirectAddress: 'DIRECT://0279...',
      network: 'mainnet',
      healthPort: 9401,
    });
    expect(env['UNICITY_NETWORK']).toBe('mainnet');
  });

  it('points TEMPLATES_PATH at the container-internal mount', () => {
    const env = buildHmEnv({
      controllerPubkey: '02ab',
      hostId: 'u-test',
      managerPubkey: '0279...',
      managerDirectAddress: 'DIRECT://0279...',
      healthPort: 9401,
    });
    // Pinned by Dockerfile.host-manager — not configurable on the HM side.
    expect(env['TEMPLATES_PATH']).toBe('/app/config/templates.json');
    expect(env['SPHERE_MANAGER_DATA_DIR']).toBe('/app/sphere-manager');
    expect(env['PERSISTENCE_PATH']).toBe('/app/state/state.json');
  });
});

describe('ensureTemplatesFile', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-cli-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('writes the bundled templates.json with trader-agent + escrow-service', () => {
    const target = ensureTemplatesFile(tmp);
    expect(fs.existsSync(target)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as { templates: Array<{ template_id: string }> };
    const ids = parsed.templates.map((t) => t.template_id);
    expect(ids).toContain('trader-agent');
    expect(ids).toContain('escrow-service');
  });

  it('copies a user-supplied templates file when provided', () => {
    const customSource = path.join(tmp, 'custom.json');
    fs.writeFileSync(customSource, JSON.stringify({ templates: [{ template_id: 'custom' }] }));
    const targetDir = fs.mkdtempSync(path.join(tmp, 'target-'));
    const target = ensureTemplatesFile(targetDir, customSource);
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as { templates: Array<{ template_id: string }> };
    expect(parsed.templates[0]?.template_id).toBe('custom');
  });

  it('throws on missing templates-file', () => {
    expect(() => ensureTemplatesFile(tmp, '/no/such/file.json')).toThrow(/not found/);
  });

  it('overwrites on each call (so a CLI upgrade re-publishes bundled defaults)', () => {
    const target = ensureTemplatesFile(tmp);
    fs.writeFileSync(target, '{}'); // mutate
    ensureTemplatesFile(tmp);
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    expect(parsed).toEqual(DEFAULT_TEMPLATES);
  });
});

describe('readMetadata roundtrip', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-cli-meta-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns null when sidecar file is missing', () => {
    expect(readMetadata(tmp)).toBeNull();
  });

  it('returns null when sidecar file is malformed JSON', () => {
    fs.writeFileSync(path.join(tmp, 'sphere-cli-meta.json'), '{not-json');
    expect(readMetadata(tmp)).toBeNull();
  });

  it('returns null when shape is wrong', () => {
    fs.writeFileSync(path.join(tmp, 'sphere-cli-meta.json'), JSON.stringify({ foo: 'bar' }));
    expect(readMetadata(tmp)).toBeNull();
  });

  it('returns the metadata when shape is valid', () => {
    const m = {
      controllerPubkey: '02ab',
      managerPubkey: '0279',
      managerDirectAddress: 'DIRECT://0279',
      managerNametag: 'm-test',
      hostId: 'u-test',
      containerName: 'sphere-hm-02ab',
      image: 'ghcr.io/x:y',
      healthPort: 9401,
      createdAt: '2026-06-10T00:00:00Z',
    };
    fs.writeFileSync(path.join(tmp, 'sphere-cli-meta.json'), JSON.stringify(m));
    expect(readMetadata(tmp)).toEqual(m);
  });
});
