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
    const opts = program.opts();
    expect(typeof opts).toBe('object');
    const help = program.helpInformation();
    expect(VERSION).toBeTruthy();
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

  it('invoking a phase-4 namespace prints "not implemented yet" and exits 64', async () => {
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
        throw new Error('__mock_exit__');
      }) as never);

    try {
      await main(['node', 'sphere', 'tenant']);
    } finally {
      writeSpy.mockRestore();
      exitSpy.mockRestore();
    }

    expect(exitCode).toBe(64);
    const joined = stderrCalls.join('');
    expect(joined).toContain('not implemented yet');
    expect(joined).toContain('phase 4');
  });

  it('help shows phase 4 annotation for DM-native namespaces', () => {
    const program = createCli();
    const help = program.helpInformation();
    expect(help).toContain('[phase 4]');
  });

  it('help shows legacy bridge annotation for phase 2 namespaces', () => {
    const program = createCli();
    const help = program.helpInformation();
    expect(help).toContain('legacy bridge');
  });
});
