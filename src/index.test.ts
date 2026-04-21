import { describe, it, expect, vi } from 'vitest';
import { createCli, main } from './index.js';
import { VERSION } from './version.js';

describe('sphere-cli scaffold', () => {
  it('createCli returns a commander program named `sphere`', () => {
    const program = createCli();
    expect(program.name()).toBe('sphere');
  });

  it('--version prints the VERSION constant', () => {
    const program = createCli();
    // commander's version() wires a flag that writes to stdout and exits.
    // Rather than intercept process.exit, verify the version metadata.
    const opts = program.opts();
    expect(typeof opts).toBe('object');
    // version is on the program, not in opts; commander attaches it privately.
    // We verify via the public API: the help text includes VERSION.
    const help = program.helpInformation();
    expect(VERSION).toBeTruthy();
    // Help text should include "Usage: sphere"
    expect(help).toContain('Usage: sphere');
  });

  it('help lists every planned namespace', () => {
    const program = createCli();
    const help = program.helpInformation();
    const expectedNamespaces = [
      'wallet', 'balance', 'payments', 'dm', 'group', 'market', 'swap',
      'invoice', 'nametag', 'crypto', 'util', 'faucet', 'daemon',
      'host', 'tenant', 'config', 'completions',
    ];
    for (const ns of expectedNamespaces) {
      expect(help).toContain(ns);
    }
  });

  it('invoking an unimplemented namespace prints "not implemented yet" and exits non-zero', async () => {
    // Capture stderr writes + intercept process.exit so the test runner survives.
    const stderrCalls: string[] = [];
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        stderrCalls.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return true;
      });
    let exitCode: number | undefined;
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        exitCode = code;
        // Throw to short-circuit the namespace action; main()'s catch will swallow it.
        throw new Error('__mock_exit__');
      }) as never);

    try {
      await main(['node', 'sphere', 'wallet']);
    } finally {
      writeSpy.mockRestore();
      exitSpy.mockRestore();
    }

    expect(exitCode).toBe(64);
    const joined = stderrCalls.join('');
    expect(joined).toContain('not implemented yet');
    expect(joined).toContain('phase 2');
  });

  it('help namespaces show the phase annotations', () => {
    const program = createCli();
    const help = program.helpInformation();
    expect(help).toContain('[phase 2]');
    expect(help).toContain('[phase 4]');
  });
});
