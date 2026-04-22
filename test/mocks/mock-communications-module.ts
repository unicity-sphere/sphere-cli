/**
 * Test mock for {@link CommsAdapter}.
 *
 * Records all DM handlers registered via `onDirectMessage` so tests can
 * inject synthetic incoming messages through `deliverDM`.
 */

import { vi } from 'vitest';
import type { CommsAdapter, IncomingDM } from '../../src/trader/types.js';

export interface MockComms {
  readonly comms: CommsAdapter;
  readonly deliverDM: (msg: IncomingDM) => void;
}

export function buildMockComms(): MockComms {
  const dmHandlers: Array<(msg: IncomingDM) => void> = [];

  const comms: CommsAdapter = {
    sendDM: vi.fn().mockResolvedValue(undefined),
    onDirectMessage: vi.fn((handler: (msg: IncomingDM) => void) => {
      dmHandlers.push(handler);
      return () => {
        const idx = dmHandlers.indexOf(handler);
        if (idx !== -1) dmHandlers.splice(idx, 1);
      };
    }),
  };

  const deliverDM = (msg: IncomingDM): void => {
    for (const handler of dmHandlers) handler(msg);
  };

  return { comms, deliverDM };
}
