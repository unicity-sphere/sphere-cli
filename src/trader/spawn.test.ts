/**
 * Pure-function tests for the `sphere trader spawn / stop` wrapper. The
 * orchestration that touches docker, the Sphere DM transport, and the
 * agentic-hosting HM is covered by the e2e smoke (out of scope for unit
 * tests). What's covered here:
 *   - deriveTenantName (wallet-nametag → instance-name fallback)
 *   - buildTraderEnv (mirrors trader-service/test/e2e-live/helpers/tenant-fixture.ts:310-365)
 *   - isLiveState (drives the keep-hm-alive ref-count decision)
 */

import { describe, it, expect } from 'vitest';
import {
  deriveTenantName,
  buildTraderEnv,
  isLiveState,
} from './spawn.js';

describe('deriveTenantName', () => {
  it('uses the explicit name when provided', () => {
    expect(deriveTenantName('alice', '0398e7df0a45', 'my-trader')).toBe('my-trader');
  });

  it('falls back to <nametag>-trader when no explicit name', () => {
    expect(deriveTenantName('alice', '0398e7df0a45', undefined)).toBe('alice-trader');
  });

  it('lowercases the nametag', () => {
    expect(deriveTenantName('Alice', '0398e7df0a45', undefined)).toBe('alice-trader');
  });

  it('falls back to <wallet-prefix>-trader when no nametag', () => {
    expect(deriveTenantName(undefined, '0398e7df0a4580f59ceeb06bd13102d8c6e1e89905', undefined))
      .toBe('0398e7df0a45-trader');
  });

  it('treats empty nametag as missing', () => {
    expect(deriveTenantName('', '0398e7df0a4580f59ceeb06bd13102d8c6e1e89905', undefined))
      .toBe('0398e7df0a45-trader');
  });

  it('trims explicit names', () => {
    expect(deriveTenantName(undefined, '0398e7df0a45', '  my-trader  ')).toBe('my-trader');
  });
});

describe('buildTraderEnv', () => {
  it('produces an empty env when only controllerPubkey is set (controller pubkey is HM-injected, not user-supplied)', () => {
    // The HM auto-injects UNICITY_CONTROLLER_PUBKEY from the request's
    // sender pubkey. The wrapper deliberately does NOT include it in
    // user-supplied env — the HM would reject UNICITY_* prefix anyway.
    const env = buildTraderEnv({ controllerPubkey: '0398' });
    expect(env).toEqual({});
  });

  it('passes scanIntervalMs through as TRADER_SCAN_INTERVAL_MS', () => {
    const env = buildTraderEnv({ controllerPubkey: '0398', scanIntervalMs: 15000 });
    expect(env['TRADER_SCAN_INTERVAL_MS']).toBe('15000');
  });

  it('pairs TRADER_TEST_FUND with TRADER_FAULT_INJECTION_ALLOWED=1', () => {
    const env = buildTraderEnv({
      controllerPubkey: '0398',
      testFund: 'deadbeef:1000,cafebabe:500',
    });
    expect(env['TRADER_TEST_FUND']).toBe('deadbeef:1000,cafebabe:500');
    expect(env['TRADER_FAULT_INJECTION_ALLOWED']).toBe('1');
  });

  it('omits both TRADER_TEST_FUND keys when not set', () => {
    const env = buildTraderEnv({ controllerPubkey: '0398' });
    expect(env).not.toHaveProperty('TRADER_TEST_FUND');
    expect(env).not.toHaveProperty('TRADER_FAULT_INJECTION_ALLOWED');
  });

  it('does NOT emit any UNICITY_* key — HM blocks the entire prefix in user env', () => {
    // Defense-in-depth: even if a future opt sets a UNICITY_* key, the
    // HM (agentic_hosting/src/host-manager/manager.ts:113) rejects the
    // entire hm.spawn payload with `Forbidden env var prefix`. The
    // wrapper must keep this surface clean.
    const env = buildTraderEnv({
      controllerPubkey: '0398',
      scanIntervalMs: 30000,
      testFund: 'aa:1',
    });
    for (const key of Object.keys(env)) {
      expect(key.toUpperCase().startsWith('UNICITY_'), `key ${key} has forbidden UNICITY_ prefix`).toBe(false);
    }
  });
});

describe('isLiveState', () => {
  it('treats CREATED, BOOTING, RUNNING as live', () => {
    expect(isLiveState('CREATED')).toBe(true);
    expect(isLiveState('BOOTING')).toBe(true);
    expect(isLiveState('RUNNING')).toBe(true);
  });

  it('treats STOPPED, FAILED as not live', () => {
    expect(isLiveState('STOPPED')).toBe(false);
    expect(isLiveState('FAILED')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isLiveState('running')).toBe(true);
    expect(isLiveState('Stopped')).toBe(false);
  });

  it('treats unknown states as not live', () => {
    expect(isLiveState('PAUSED')).toBe(false);
    expect(isLiveState('')).toBe(false);
  });
});
