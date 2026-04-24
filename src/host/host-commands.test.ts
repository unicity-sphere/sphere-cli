/**
 * Pure-function tests for `sphere host` helpers — no DM transport, no real
 * Sphere. Exercises the exported parsers (parseEnvPairs, parseJsonParams,
 * parseTimeout, targetPayload) and the commander wiring around
 * createHostCommand.
 */

import { describe, it, expect } from 'vitest';
import type { Command } from 'commander';
import {
  parseEnvPairs,
  parseJsonParams,
  parseTimeout,
  targetPayload,
  createHostCommand,
} from './host-commands.js';

describe('parseEnvPairs', () => {
  it('returns undefined when no pairs supplied', () => {
    expect(parseEnvPairs(undefined)).toBeUndefined();
    expect(parseEnvPairs([])).toBeUndefined();
  });

  it('parses a single KEY=VALUE', () => {
    expect(parseEnvPairs(['FOO=1'])).toEqual({ FOO: '1' });
  });

  it('accumulates across multiple --env flags', () => {
    expect(parseEnvPairs(['FOO=1', 'BAR=2'])).toEqual({ FOO: '1', BAR: '2' });
  });

  it('preserves `=` inside the value', () => {
    expect(parseEnvPairs(['URL=postgres://user:pass=secret@host/db']))
      .toEqual({ URL: 'postgres://user:pass=secret@host/db' });
  });

  it('trims whitespace in the key but not the value', () => {
    expect(parseEnvPairs(['  FOO  =bar ']))
      .toEqual({ FOO: 'bar ' });
  });

  it('throws on missing `=`', () => {
    expect(() => parseEnvPairs(['no-equals'])).toThrow(/expected KEY=VALUE/);
  });

  it('throws on empty key', () => {
    expect(() => parseEnvPairs(['=bar'])).toThrow(/expected KEY=VALUE/);
  });
});

describe('parseJsonParams', () => {
  it('returns undefined for undefined input', () => {
    expect(parseJsonParams(undefined)).toBeUndefined();
  });

  it('parses a flat JSON object', () => {
    expect(parseJsonParams('{"a":1,"b":"x"}')).toEqual({ a: 1, b: 'x' });
  });

  it('throws on invalid JSON', () => {
    expect(() => parseJsonParams('{not-json')).toThrow(/Invalid --params JSON/);
  });

  it('throws when value is not a JSON object', () => {
    expect(() => parseJsonParams('[1,2,3]')).toThrow(/must be a JSON object/);
    expect(() => parseJsonParams('"string"')).toThrow(/must be a JSON object/);
    expect(() => parseJsonParams('42')).toThrow(/must be a JSON object/);
    expect(() => parseJsonParams('null')).toThrow(/must be a JSON object/);
  });

  it('rejects __proto__ at top level', () => {
    expect(() => parseJsonParams('{"__proto__":{"polluted":true}}'))
      .toThrow(/forbidden keys/);
  });

  it('rejects nested __proto__', () => {
    expect(() => parseJsonParams('{"a":{"b":{"__proto__":{"x":1}}}}'))
      .toThrow(/forbidden keys/);
  });

  it('rejects constructor and prototype at any depth', () => {
    expect(() => parseJsonParams('{"constructor":{}}')).toThrow(/forbidden keys/);
    expect(() => parseJsonParams('{"a":{"prototype":{}}}')).toThrow(/forbidden keys/);
  });

  it('rejects deeply-nested JSON via explicit depth cap (no stack overflow)', () => {
    // Build 200-deep nesting — well past MAX_PARAMS_DEPTH (64). The hardened
    // hasDangerousKeys uses an explicit stack + depth bound, returning true
    // ("too deep to inspect — conservative reject") before blowing the
    // interpreter stack.
    let deep = '{}';
    for (let i = 0; i < 200; i++) deep = `{"a":${deep}}`;
    expect(() => parseJsonParams(deep)).toThrow(/forbidden keys/);
  });
});

describe('parseTimeout', () => {
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
});

describe('targetPayload', () => {
  it('uses instance_name by default', () => {
    expect(targetPayload('mybot', {})).toEqual({ instance_name: 'mybot' });
  });

  it('uses instance_id when --id is set', () => {
    expect(targetPayload('550e8400-e29b-41d4-a716-446655440000', { id: true }))
      .toEqual({ instance_id: '550e8400-e29b-41d4-a716-446655440000' });
  });
});

describe('createHostCommand --env variadic-bug regression test', () => {
  // Ship-blocker from pre-merge review: `--env <KEY=VAL...>` (with ellipsis)
  // greedily consumed every subsequent non-flag arg, including the positional
  // <name>. After the fix, `--env <KEY=VAL>` (single-arg) + argParser
  // accumulator handles multi-env via repetition. The positional `name`
  // must not be swallowed.

  it('`--env FOO=1 --env BAR=2 mybot` captures both env pairs AND name', () => {
    const host = createHostCommand();
    host.exitOverride();  // commander should not call process.exit during the test

    let capturedName: string | undefined;
    let capturedEnv: string[] | undefined;

    // Replace the spawn action to capture parsed values instead of dialling
    // out to the real DM transport.
    const spawn = host.commands.find((c) => c.name() === 'spawn')!;
    spawn.action(function (this: Command, name: string, opts: { env?: string[] }) {
      capturedName = name;
      capturedEnv = opts.env;
    });

    host.parse(
      ['node', 'host', 'spawn', '--template', 'tpl-1', '--env', 'FOO=1', '--env', 'BAR=2', 'mybot'],
      { from: 'node' },
    );

    expect(capturedName).toBe('mybot');
    expect(capturedEnv).toEqual(['FOO=1', 'BAR=2']);
  });

  it('`--env FOO=1 mybot` captures env + name (single --env form)', () => {
    const host = createHostCommand();
    host.exitOverride();

    let capturedName: string | undefined;
    let capturedEnv: string[] | undefined;

    const spawn = host.commands.find((c) => c.name() === 'spawn')!;
    spawn.action(function (this: Command, name: string, opts: { env?: string[] }) {
      capturedName = name;
      capturedEnv = opts.env;
    });

    host.parse(
      ['node', 'host', 'spawn', '--template', 'tpl-1', '--env', 'FOO=1', 'mybot'],
      { from: 'node' },
    );

    expect(capturedName).toBe('mybot');
    expect(capturedEnv).toEqual(['FOO=1']);
  });
});

describe('createHostCommand inherited-options help', () => {
  // Commander's addHelpText('after', ...) attaches via the `afterHelp` event,
  // which fires during outputHelp() (stdout) — not via helpInformation() which
  // only returns the core Usage/Options block. Capture stdout to verify.
  it('each subcommand --help renders the shared --manager/--json/--timeout options', () => {
    const host = createHostCommand();
    for (const sub of host.commands) {
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
      expect(captured, `subcommand "${sub.name()}" should render inherited --manager`)
        .toContain('--manager');
      expect(captured).toContain('--json');
      expect(captured).toContain('--timeout');
    }
  });
});
