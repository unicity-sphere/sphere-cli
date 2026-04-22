/**
 * Test mock for {@link SwapAdapter}.
 *
 * Tracks proposed swaps in an internal map so `getStatus()` reflects the
 * expected lifecycle transitions. Tests can override state with the returned
 * `setStatus` helper.
 */

import { vi } from 'vitest';
import type {
  SwapAdapter,
  SwapProposalParams,
  SwapProposalResult,
  SwapStatus,
} from '../../src/trader/types.js';

export interface MockSwap {
  readonly swap: SwapAdapter;
  readonly setStatus: (swapId: string, status: Partial<SwapStatus>) => void;
  readonly swapStatuses: Map<string, SwapStatus>;
}

export function buildMockSwap(): MockSwap {
  const swapStatuses = new Map<string, SwapStatus>();
  let swapCounter = 0;

  const swap: SwapAdapter = {
    propose: vi
      .fn()
      .mockImplementation(async (_params: SwapProposalParams): Promise<SwapProposalResult> => {
        const swapId = `swap-${++swapCounter}`;
        swapStatuses.set(swapId, { swapId, state: 'PROPOSED' });
        return { swapId };
      }),
    accept: vi.fn().mockImplementation(async (swapId: string): Promise<void> => {
      const current = swapStatuses.get(swapId);
      if (current) {
        swapStatuses.set(swapId, { ...current, state: 'ACCEPTED' });
      }
    }),
    getStatus: vi.fn().mockImplementation(async (swapId: string): Promise<SwapStatus> => {
      return swapStatuses.get(swapId) ?? { swapId, state: 'UNKNOWN' };
    }),
    load: vi.fn().mockResolvedValue(undefined),
    on: vi.fn().mockReturnValue(() => {}),
  };

  const setStatus = (swapId: string, status: Partial<SwapStatus>): void => {
    const existing = swapStatuses.get(swapId);
    swapStatuses.set(swapId, {
      swapId,
      state: 'PROPOSED',
      ...existing,
      ...status,
    });
  };

  return { swap, setStatus, swapStatuses };
}
