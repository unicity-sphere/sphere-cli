/**
 * Test mock for {@link PaymentsAdapter}.
 *
 * Holds a single confirmed-balance scalar that `getConfirmedAmount()` returns
 * for every token. Tests can override the balance with `setBalance()` to
 * simulate incoming deposits.
 */

import { vi } from 'vitest';
import type { ActiveIntent, PaymentsAdapter } from '../../src/trader/types.js';

export interface MockPayments {
  readonly payments: PaymentsAdapter;
  readonly setBalance: (balance: bigint) => void;
}

export function buildMockPayments(initialBalance: bigint = 1_000_000n): MockPayments {
  let confirmedBalance = initialBalance;

  const payments: PaymentsAdapter = {
    receive: vi.fn().mockResolvedValue({
      address: `DIRECT://${'a'.repeat(64)}`,
      pubkey: 'a'.repeat(64),
    }),
    getMyIntents: vi.fn().mockResolvedValue([] as ActiveIntent[]),
    payInvoice: vi.fn().mockResolvedValue(undefined),
    getConfirmedAmount: vi
      .fn()
      .mockImplementation(async (_token: string): Promise<bigint> => confirmedBalance),
  };

  const setBalance = (balance: bigint): void => {
    confirmedBalance = balance;
  };

  return { payments, setBalance };
}
