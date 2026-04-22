/**
 * Test mock for {@link MarketAdapter}.
 *
 * Exposes all adapter methods as vitest `vi.fn()` spies so assertions can
 * check call counts / arguments. Also records every feed subscriber so tests
 * can synthesize market feed events via the returned `deliverListing` helper.
 */

import { vi } from 'vitest';
import type { MarketAdapter, MarketListing } from '../../src/trader/types.js';

export interface MockMarket {
  readonly market: MarketAdapter;
  readonly deliverListing: (listing: MarketListing) => void;
}

export function buildMockMarket(): MockMarket {
  const feedListeners: Array<(listing: MarketListing) => void> = [];

  const market: MarketAdapter = {
    post: vi.fn().mockImplementation(async () => `listing-${crypto.randomUUID()}`),
    remove: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([] as MarketListing[]),
    subscribeFeed: vi.fn((listener: (listing: MarketListing) => void) => {
      feedListeners.push(listener);
      return () => {
        const idx = feedListeners.indexOf(listener);
        if (idx !== -1) feedListeners.splice(idx, 1);
      };
    }),
    getRecentListings: vi.fn().mockResolvedValue([] as MarketListing[]),
  };

  // Helper to push a listing into all active feed subscribers.
  const deliverListing = (listing: MarketListing): void => {
    for (const listener of feedListeners) listener(listing);
  };

  return { market, deliverListing };
}
