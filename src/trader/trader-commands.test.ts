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
  it('exposes the 6 controller-scoped trader subcommands', () => {
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
