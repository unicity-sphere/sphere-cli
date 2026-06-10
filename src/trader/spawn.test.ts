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
  it('always sets UNICITY_CONTROLLER_PUBKEY', () => {
    const env = buildTraderEnv({ controllerPubkey: '0398' });
    expect(env['UNICITY_CONTROLLER_PUBKEY']).toBe('0398');
  });

  it('omits TRADER_SCAN_INTERVAL_MS when not set', () => {
    const env = buildTraderEnv({ controllerPubkey: '0398' });
    expect(env).not.toHaveProperty('TRADER_SCAN_INTERVAL_MS');
  });

  it('passes scanIntervalMs through as string', () => {
    const env = buildTraderEnv({ controllerPubkey: '0398', scanIntervalMs: 15000 });
    expect(env['TRADER_SCAN_INTERVAL_MS']).toBe('15000');
  });

  it('joins trustedEscrows with commas', () => {
    const env = buildTraderEnv({
      controllerPubkey: '0398',
      trustedEscrows: ['@escrow-test-02', '@my-local-escrow'],
    });
    expect(env['UNICITY_TRUSTED_ESCROWS']).toBe('@escrow-test-02,@my-local-escrow');
  });

  it('omits UNICITY_TRUSTED_ESCROWS when list is empty', () => {
    const env = buildTraderEnv({ controllerPubkey: '0398', trustedEscrows: [] });
    expect(env).not.toHaveProperty('UNICITY_TRUSTED_ESCROWS');
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

  it('passes through the network override', () => {
    const env = buildTraderEnv({ controllerPubkey: '0398', network: 'dev' });
    expect(env['UNICITY_NETWORK']).toBe('dev');
  });

  it('does NOT set ACP boot envelope keys (HM injects those)', () => {
    // UNICITY_MANAGER_PUBKEY / UNICITY_BOOT_TOKEN / UNICITY_INSTANCE_ID /
    // UNICITY_INSTANCE_NAME / UNICITY_TEMPLATE_ID are injected by the HM
    // when it spawns the tenant container. The wrapper layer must not
    // override them — see spawn.ts comment block.
    const env = buildTraderEnv({ controllerPubkey: '0398' });
    expect(env).not.toHaveProperty('UNICITY_MANAGER_PUBKEY');
    expect(env).not.toHaveProperty('UNICITY_BOOT_TOKEN');
    expect(env).not.toHaveProperty('UNICITY_INSTANCE_ID');
    expect(env).not.toHaveProperty('UNICITY_INSTANCE_NAME');
    expect(env).not.toHaveProperty('UNICITY_TEMPLATE_ID');
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
