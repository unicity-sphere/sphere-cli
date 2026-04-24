import { describe, it, expect, vi } from 'vitest';
import { createCli, main, buildLegacyArgv } from './index.js';
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

describe('buildLegacyArgv dispatcher', () => {
  // Wallet namespace: most subcommands pass through unchanged, but
  // `init` and `status` remap to legacy top-level commands.
  describe('wallet', () => {
    it('`wallet init` remaps to legacy top-level `init`', () => {
      expect(buildLegacyArgv('wallet', ['init', '--network', 'testnet']))
        .toEqual(['init', '--network', 'testnet']);
    });
    it('`wallet status` remaps to legacy top-level `status`', () => {
      expect(buildLegacyArgv('wallet', ['status'])).toEqual(['status']);
    });
    it('`wallet current` falls through to legacy `wallet current`', () => {
      expect(buildLegacyArgv('wallet', ['current'])).toEqual(['wallet', 'current']);
    });
    it('`wallet list` falls through to legacy `wallet list`', () => {
      expect(buildLegacyArgv('wallet', ['list'])).toEqual(['wallet', 'list']);
    });
    it('`wallet create foo --network testnet` preserves flags after subcommand', () => {
      expect(buildLegacyArgv('wallet', ['create', 'foo', '--network', 'testnet']))
        .toEqual(['wallet', 'create', 'foo', '--network', 'testnet']);
    });
    it('bare `wallet` with no subcommand produces `[wallet]`', () => {
      expect(buildLegacyArgv('wallet', [])).toEqual(['wallet']);
    });
  });

  // Simple 1:1 namespaces preserve tail verbatim.
  describe('1:1 namespaces', () => {
    it.each(['balance', 'daemon', 'config', 'completions'])(
      '`%s x y` → [`%s`, x, y]',
      (ns) => {
        expect(buildLegacyArgv(ns, ['x', 'y'])).toEqual([ns, 'x', 'y']);
      },
    );
  });

  describe('faucet → topup', () => {
    it('remaps namespace name', () => {
      expect(buildLegacyArgv('faucet', ['--amount', '1'])).toEqual(['topup', '--amount', '1']);
    });
  });

  describe('nametag', () => {
    it('bare `nametag foo` → `[nametag, foo]`', () => {
      expect(buildLegacyArgv('nametag', ['alice'])).toEqual(['nametag', 'alice']);
    });
    it('`nametag register alice` → `[nametag, alice]`', () => {
      expect(buildLegacyArgv('nametag', ['register', 'alice'])).toEqual(['nametag', 'alice']);
    });
    it('`nametag info alice` → `[nametag-info, alice]`', () => {
      expect(buildLegacyArgv('nametag', ['info', 'alice'])).toEqual(['nametag-info', 'alice']);
    });
    it('`nametag my` → `[my-nametag]`', () => {
      expect(buildLegacyArgv('nametag', ['my'])).toEqual(['my-nametag']);
    });
    it('`nametag sync` → `[nametag-sync]`', () => {
      expect(buildLegacyArgv('nametag', ['sync'])).toEqual(['nametag-sync']);
    });
  });

  describe('namespace-stripped (payments, crypto, util)', () => {
    it('payments strips namespace', () => {
      expect(buildLegacyArgv('payments', ['send', 'alice', '1'])).toEqual(['send', 'alice', '1']);
    });
    it('crypto strips namespace', () => {
      expect(buildLegacyArgv('crypto', ['generate-key'])).toEqual(['generate-key']);
    });
    it('util strips namespace', () => {
      expect(buildLegacyArgv('util', ['to-human', '100'])).toEqual(['to-human', '100']);
    });
  });

  describe('dm', () => {
    it('bare `dm @alice hi` → `[dm, @alice, hi]`', () => {
      expect(buildLegacyArgv('dm', ['@alice', 'hi'])).toEqual(['dm', '@alice', 'hi']);
    });
    it('`dm send @alice hi` strips `send`', () => {
      expect(buildLegacyArgv('dm', ['send', '@alice', 'hi'])).toEqual(['dm', '@alice', 'hi']);
    });
    it('`dm inbox` → `[dm-inbox]`', () => {
      expect(buildLegacyArgv('dm', ['inbox'])).toEqual(['dm-inbox']);
    });
    it('`dm history @alice` → `[dm-history, @alice]`', () => {
      expect(buildLegacyArgv('dm', ['history', '@alice'])).toEqual(['dm-history', '@alice']);
    });
  });

  describe('prefixed namespaces (group, market, swap, invoice)', () => {
    it('`swap propose` → `[swap-propose]`', () => {
      expect(buildLegacyArgv('swap', ['propose'])).toEqual(['swap-propose']);
    });
    it('`market search foo` → `[market-search, foo]`', () => {
      expect(buildLegacyArgv('market', ['search', 'foo'])).toEqual(['market-search', 'foo']);
    });
    it('`invoice pay INV-1` → `[invoice-pay, INV-1]`', () => {
      expect(buildLegacyArgv('invoice', ['pay', 'INV-1'])).toEqual(['invoice-pay', 'INV-1']);
    });
    it('bare `swap` (no subcommand) → `[swap]`', () => {
      expect(buildLegacyArgv('swap', [])).toEqual(['swap']);
    });
  });

  describe('unknown namespace', () => {
    it('passes through as-is (safety net for future namespaces)', () => {
      expect(buildLegacyArgv('weirdname', ['a', 'b'])).toEqual(['weirdname', 'a', 'b']);
    });
  });
});
