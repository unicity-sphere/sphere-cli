/**
 * Unit tests for `detectWalletKind`.
 *
 * Pure filesystem detection — no provider construction. Drives the
 * issue #23 migration prompt and the `wallet migrate` short-circuit.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { detectWalletKind } from './sphere-providers.js';

describe('detectWalletKind', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-cli-detect-'));
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('returns "fresh" when dataDir does not exist', () => {
    const missing = path.join(scratch, 'never-created');
    expect(detectWalletKind(missing)).toBe('fresh');
  });

  it('returns "fresh" when dataDir exists but contains no wallet markers', () => {
    // dataDir exists (e.g. user `mkdir -p` for a future init) but the
    // CLI has never put anything in it.
    expect(detectWalletKind(scratch)).toBe('fresh');
  });

  it('returns "legacy" when only wallet.json exists', () => {
    fs.writeFileSync(path.join(scratch, 'wallet.json'), '{"mnemonic":"..."}');
    expect(detectWalletKind(scratch)).toBe('legacy');
  });

  it('returns "profile" when orbitdb/ exists', () => {
    // Profile bootstraps create the orbitdb subdir; the wallet.json
    // local-cache file lives alongside it. We test BOTH the
    // wallet.json-present and -absent cases — the orbitdb subdir is
    // the authoritative marker.
    fs.mkdirSync(path.join(scratch, 'orbitdb'));
    expect(detectWalletKind(scratch)).toBe('profile');
  });

  it('returns "profile" even when both orbitdb/ and wallet.json are present', () => {
    // The Profile factory wraps a FileStorageProvider as the local
    // cache, so a healthy Profile wallet has BOTH markers on disk.
    // detectWalletKind must NOT misclassify this as 'legacy'.
    fs.writeFileSync(path.join(scratch, 'wallet.json'), '{"mnemonic":"..."}');
    fs.mkdirSync(path.join(scratch, 'orbitdb'));
    expect(detectWalletKind(scratch)).toBe('profile');
  });

  it('returns "fresh" when an unrelated file exists in dataDir', () => {
    // Sanity check — random files (like a config.json or a
    // user-dropped readme) should not trip detection.
    fs.writeFileSync(path.join(scratch, 'config.json'), '{}');
    fs.writeFileSync(path.join(scratch, 'README.md'), '# nothing');
    expect(detectWalletKind(scratch)).toBe('fresh');
  });
});
