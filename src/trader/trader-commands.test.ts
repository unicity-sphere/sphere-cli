/**
 * Pure-function tests for `sphere trader` helpers — no DM transport, no
 * real Sphere. Exercises the exported parsers (parseTimeout) and the
 * commander wiring around createTraderCommand.
 */

import { describe, it, expect } from 'vitest';
import type { Command } from 'commander';
import {
  parseTimeout,
  resolveTenantAddress,
  createTraderCommand,
  buildCreateIntentParams,
  buildWithdrawParams,
} from './trader-commands.js';

describe('parseTimeout (trader)', () => {
  it('falls back when input is undefined', () => {
    expect(parseTimeout(undefined, 5000)).toBe(5000);
  });

  it('parses a valid positive integer', () => {
    expect(parseTimeout('1000', 5000)).toBe(1000);
  });

  it('floors a decimal', () => {
    expect(parseTimeout('1234.7', 5000)).toBe(1234);
  });

  it('throws on zero, negative, NaN, Infinity', () => {
    expect(() => parseTimeout('0', 5000)).toThrow(/Invalid timeout/);
    expect(() => parseTimeout('-100', 5000)).toThrow(/Invalid timeout/);
    expect(() => parseTimeout('abc', 5000)).toThrow(/Invalid timeout/);
    expect(() => parseTimeout('Infinity', 5000)).toThrow(/Invalid timeout/);
  });

  it('rejects values below MIN_TIMEOUT_MS=100ms', () => {
    expect(() => parseTimeout('99', 5000)).toThrow(/minimum 100ms/);
    expect(() => parseTimeout('50', 5000)).toThrow(/minimum 100ms/);
    expect(() => parseTimeout('1', 5000)).toThrow(/minimum 100ms/);
  });

  it('accepts values at and above MIN_TIMEOUT_MS=100ms', () => {
    expect(parseTimeout('100', 5000)).toBe(100);
    expect(parseTimeout('30000', 5000)).toBe(30000);
  });
});

describe('resolveTenantAddress', () => {
  it('uses --tenant flag when supplied', () => {
    expect(resolveTenantAddress({ tenant: '@trader-alice' })).toBe('@trader-alice');
  });

  it('trims whitespace', () => {
    expect(resolveTenantAddress({ tenant: '  @trader-bob  ' })).toBe('@trader-bob');
  });

  it('falls back to SPHERE_TRADER_TENANT env var', () => {
    const prev = process.env['SPHERE_TRADER_TENANT'];
    process.env['SPHERE_TRADER_TENANT'] = '@env-fallback';
    try {
      expect(resolveTenantAddress({})).toBe('@env-fallback');
    } finally {
      if (prev === undefined) delete process.env['SPHERE_TRADER_TENANT'];
      else process.env['SPHERE_TRADER_TENANT'] = prev;
    }
  });

  it('throws when neither flag nor env var is set', () => {
    const prev = process.env['SPHERE_TRADER_TENANT'];
    delete process.env['SPHERE_TRADER_TENANT'];
    try {
      expect(() => resolveTenantAddress({})).toThrow(/No trader tenant address/);
      expect(() => resolveTenantAddress({ tenant: '' })).toThrow(/No trader tenant address/);
      expect(() => resolveTenantAddress({ tenant: '   ' })).toThrow(/No trader tenant address/);
    } finally {
      if (prev !== undefined) process.env['SPHERE_TRADER_TENANT'] = prev;
    }
  });
});

describe('createTraderCommand', () => {
  it('exposes the 7 controller-scoped trader subcommands', () => {
    const trader = createTraderCommand();
    const names = trader.commands.map((c) => c.name()).sort();
    // No `status` here: STATUS is system-scoped per Unicity
    // architecture and routes through the host manager via HMCP.
    // Use `sphere host inspect <instance>` for trader liveness.
    expect(names).toEqual([
      'cancel-intent',
      'create-intent',
      'list-deals',
      'list-intents',
      'portfolio',
      'set-strategy',
      'withdraw',
    ]);
  });

  it('attaches the inherited-options help to every subcommand', () => {
    const trader = createTraderCommand();
    for (const sub of trader.commands) {
      let captured = '';
      const origWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string | Uint8Array): boolean => {
        captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
      }) as typeof process.stdout.write;
      try {
        sub.outputHelp();
      } finally {
        process.stdout.write = origWrite;
      }
      expect(captured, `subcommand "${sub.name()}" should render inherited --tenant`)
        .toContain('--tenant');
      expect(captured).toContain('--json');
      expect(captured).toContain('--timeout');
    }
  });

  it('create-intent declares all required flags', () => {
    const trader = createTraderCommand();
    const cmd = trader.commands.find((c) => c.name() === 'create-intent');
    expect(cmd).toBeDefined();
    const optionFlags = cmd!.options.map((o) => o.long);
    expect(optionFlags).toEqual(expect.arrayContaining([
      '--direction', '--base', '--quote', '--rate-min', '--rate-max',
      '--volume-min', '--volume-max', '--expiry-ms',
    ]));
  });

  it('cancel-intent requires --intent-id', () => {
    const trader = createTraderCommand();
    const cmd = trader.commands.find((c) => c.name() === 'cancel-intent');
    expect(cmd).toBeDefined();
    const intentIdOption = cmd!.options.find((o) => o.long === '--intent-id');
    expect(intentIdOption).toBeDefined();
    expect(intentIdOption!.required).toBe(true);
  });

  it('list-intents and list-deals have optional --state and --limit', () => {
    const trader = createTraderCommand();
    for (const name of ['list-intents', 'list-deals']) {
      const cmd = trader.commands.find((c) => c.name() === name);
      expect(cmd, name).toBeDefined();
      const flags = cmd!.options.map((o) => o.long);
      expect(flags, name).toEqual(expect.arrayContaining(['--state', '--limit']));
    }
  });

  it('set-strategy has all three optional knobs', () => {
    const trader = createTraderCommand();
    const cmd = trader.commands.find((c) => c.name() === 'set-strategy');
    expect(cmd).toBeDefined();
    const flags = cmd!.options.map((o) => o.long);
    expect(flags).toEqual(expect.arrayContaining([
      '--rate-strategy', '--max-concurrent', '--trusted-escrows',
    ]));
  });

  it('parent has --tenant, --json, --timeout global options', () => {
    const trader = createTraderCommand();
    const flags = trader.options.map((o) => o.long);
    expect(flags).toEqual(expect.arrayContaining(['--tenant', '--json', '--timeout']));
  });

  it('subcommand action functions are wired', () => {
    const trader = createTraderCommand();
    // Each subcommand should have an action handler attached. Access via
    // the internal _actionHandler property — fragile but good as a smoke test
    // that registration didn't silently drop the .action() call.
    for (const sub of trader.commands) {
      const actionHandler = (sub as Command & { _actionHandler?: unknown })._actionHandler;
      expect(actionHandler, `subcommand "${sub.name()}" should have an action handler`)
        .toBeDefined();
    }
  });
});

describe('buildCreateIntentParams (wire shape)', () => {
  // Minimal valid opts; individual tests override the field they are exercising.
  const baseOpts = {
    direction: 'buy',
    base: 'UCT',
    quote: 'USDU',
    rateMin: '100',
    rateMax: '200',
    volumeMin: '10',
    volumeMax: '100',
  };

  it('emits volume_max (not volume_total) on the wire', () => {
    const result = buildCreateIntentParams(baseOpts);
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.params['volume_max']).toBe('100');
    expect(result.params).not.toHaveProperty('volume_total');
  });

  it('converts --expiry-ms to expiry_sec at the wire boundary (5000ms → 5s)', () => {
    const result = buildCreateIntentParams({ ...baseOpts, expiryMs: '5000' });
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.params['expiry_sec']).toBe(5);
    expect(result.params).not.toHaveProperty('expiry_ms');
  });

  it('floors fractional seconds (90500ms → 90s)', () => {
    const result = buildCreateIntentParams({ ...baseOpts, expiryMs: '90500' });
    if ('error' in result) throw new Error(result.error);
    expect(result.params['expiry_sec']).toBe(90);
  });

  it('omits expiry_sec when --expiry-ms not provided', () => {
    const result = buildCreateIntentParams(baseOpts);
    if ('error' in result) throw new Error(result.error);
    expect(result.params).not.toHaveProperty('expiry_sec');
    expect(result.params).not.toHaveProperty('expiry_ms');
  });

  it('rejects sub-1000ms expiries with a clear CLI-layer message', () => {
    const result = buildCreateIntentParams({ ...baseOpts, expiryMs: '999' });
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toMatch(/at least 1000.*1 second/);
    expect(result.error).toContain('999');
  });

  it('rejects expiries greater than 7 days', () => {
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const result = buildCreateIntentParams({ ...baseOpts, expiryMs: String(sevenDaysMs + 1) });
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toMatch(/7 days/);
  });

  it('accepts the boundary cases — exactly 1000ms and exactly 7 days', () => {
    const lower = buildCreateIntentParams({ ...baseOpts, expiryMs: '1000' });
    if ('error' in lower) throw new Error(lower.error);
    expect(lower.params['expiry_sec']).toBe(1);

    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const upper = buildCreateIntentParams({ ...baseOpts, expiryMs: String(sevenDaysMs) });
    if ('error' in upper) throw new Error(upper.error);
    expect(upper.params['expiry_sec']).toBe(sevenDaysMs / 1000);
  });

  it('rejects non-numeric, zero, and negative expiry-ms', () => {
    for (const bad of ['abc', '0', '-100', 'NaN']) {
      const r = buildCreateIntentParams({ ...baseOpts, expiryMs: bad });
      expect('error' in r, `expected error for expiry-ms="${bad}"`).toBe(true);
    }
  });

  it('documents parseInt prefix-truncation behavior on scientific notation', () => {
    // parseInt('1e6', 10) returns 1 (parses '1', stops at 'e').
    // The user wanted 1_000_000 ms (≈1000s ≈ 16.7m) but got the
    // truncated value 1, then our < 1000ms guard fires and rejects.
    // Counterintuitive but at least the value is REJECTED rather
    // than silently misused. This test pins the surprising
    // behavior so a future strict-parse refactor (e.g., using
    // `Number(s)` which rejects 'e' in this context) is tracked
    // as a deliberate change rather than an accidental drift.
    //
    // FIXME: harden numeric parsing across this file with a
    // strict-positive-int helper. Same pattern affects --limit,
    // --max-concurrent, --timeout. Out of scope for this PR.
    const result = buildCreateIntentParams({ ...baseOpts, expiryMs: '1e6' });
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    // The error message reports the parsed value (1), not the
    // user's original input (1e6) — that's the surprising part.
    expect(result.error).toMatch(/got 1\b/);
  });

  it('rejects invalid direction', () => {
    const result = buildCreateIntentParams({ ...baseOpts, direction: 'sideways' });
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toMatch(/buy.*sell/);
  });

  it('passes through bigint-string fields verbatim (no coercion)', () => {
    const huge = '99999999999999999999999999';
    const result = buildCreateIntentParams({ ...baseOpts, volumeMax: huge });
    if ('error' in result) throw new Error(result.error);
    // Must preserve the exact string — coercion to Number would lose
    // precision and bigint serialization differs across SDKs.
    expect(result.params['volume_max']).toBe(huge);
  });
});

describe('buildWithdrawParams (wire shape)', () => {
  const baseOpts = {
    asset: 'UCT',
    amount: '1000',
    toAddress: '@alice',
  };

  it('emits asset / amount / to_address (snake_case wire fields)', () => {
    const result = buildWithdrawParams(baseOpts);
    if ('error' in result) throw new Error(result.error);
    expect(result.params['asset']).toBe('UCT');
    expect(result.params['amount']).toBe('1000');
    expect(result.params['to_address']).toBe('@alice');
    expect(result.params).not.toHaveProperty('toAddress');
  });

  it('preserves bigint-string amount verbatim (no coercion to Number)', () => {
    const huge = '99999999999999999999999999';
    const result = buildWithdrawParams({ ...baseOpts, amount: huge });
    if ('error' in result) throw new Error(result.error);
    expect(result.params['amount']).toBe(huge);
  });

  it('rejects empty asset', () => {
    const result = buildWithdrawParams({ ...baseOpts, asset: '' });
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toMatch(/asset is required/);
  });

  it('rejects whitespace-only asset', () => {
    const result = buildWithdrawParams({ ...baseOpts, asset: '   ' });
    expect('error' in result).toBe(true);
  });

  it('rejects empty amount', () => {
    const result = buildWithdrawParams({ ...baseOpts, amount: '' });
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toMatch(/amount is required/);
  });

  it('rejects zero, negative, decimal, scientific notation, leading-zero amounts', () => {
    for (const bad of ['0', '-100', '1.5', '1e6', '01000', 'abc']) {
      const r = buildWithdrawParams({ ...baseOpts, amount: bad });
      expect('error' in r, `expected error for amount="${bad}"`).toBe(true);
    }
  });

  it('rejects empty to-address', () => {
    const result = buildWithdrawParams({ ...baseOpts, toAddress: '' });
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toMatch(/to-address is required/);
  });

  it('accepts all three address forms (@nametag, DIRECT://hex, raw hex)', () => {
    for (const addr of [
      '@alice',
      'DIRECT://0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    ]) {
      const r = buildWithdrawParams({ ...baseOpts, toAddress: addr });
      expect('error' in r, `expected accept for to-address="${addr}"`).toBe(false);
      if ('error' in r) continue;
      expect(r.params['to_address']).toBe(addr);
    }
  });
});
