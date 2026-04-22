/**
 * Shared test fixtures and factories for the Trader Agent suite.
 *
 * Each `make*` helper produces a fully-populated record with sensible
 * defaults; tests override only the fields they care about via the
 * `overrides` parameter.
 */

import { DEFAULT_STRATEGY } from '../../src/trader/types.js';
import type {
  DealRecord,
  DealTerms,
  IntentRecord,
  TradingIntent,
  TraderStrategy,
} from '../../src/trader/types.js';

// =============================================================================
// Constants
// =============================================================================

export const TEST_PUBKEY_A = 'a'.repeat(64);
export const TEST_PUBKEY_B = 'b'.repeat(64);
export const TEST_ESCROW = 'e'.repeat(64);
export const TEST_TOKEN_ALPHA = 'ALPHA';
export const TEST_TOKEN_BETA = 'BETA';

// =============================================================================
// Factories
// =============================================================================

export function makeIntent(overrides: Partial<TradingIntent> = {}): TradingIntent {
  const now = Date.now();
  return {
    intent_id: crypto.randomUUID(),
    salt: 'deadbeef',
    owner_pubkey: TEST_PUBKEY_A,
    offer_token: TEST_TOKEN_ALPHA,
    offer_volume_min: 100n,
    offer_volume_max: 1000n,
    request_token: TEST_TOKEN_BETA,
    rate_min: 90_000_000n, // 0.9 * 1e8
    rate_max: 110_000_000n, // 1.1 * 1e8
    expiry_ms: now + 3_600_000,
    created_at_ms: now,
    deposit_timeout_sec: 3600,
    ...overrides,
  };
}

export function makeIntentRecord(overrides: Partial<IntentRecord> = {}): IntentRecord {
  return {
    intent: makeIntent(),
    state: 'ACTIVE',
    market_listing_id: null,
    volume_filled: 0n,
    updated_at_ms: Date.now(),
    ...overrides,
  };
}

export function makeDealTerms(overrides: Partial<DealTerms> = {}): DealTerms {
  return {
    proposer_intent_id: crypto.randomUUID(),
    acceptor_intent_id: crypto.randomUUID(),
    proposer_pubkey: TEST_PUBKEY_A,
    acceptor_pubkey: TEST_PUBKEY_B,
    offer_token: TEST_TOKEN_ALPHA,
    request_token: TEST_TOKEN_BETA,
    offer_volume: 500n,
    request_volume: 500n,
    rate: 100_000_000n, // 1.0 * 1e8
    escrow_address: TEST_ESCROW,
    deposit_timeout_sec: 3600,
    ...overrides,
  };
}

export function makeDealRecord(overrides: Partial<DealRecord> = {}): DealRecord {
  const now = Date.now();
  return {
    deal_id: crypto.randomUUID(),
    terms: makeDealTerms(),
    state: 'PROPOSED',
    role: 'PROPOSER',
    created_at_ms: now,
    updated_at_ms: now,
    failure_reason: null,
    deposit_attempted: false,
    payout_verified: false,
    ...overrides,
  };
}

export function makeStrategy(overrides: Partial<TraderStrategy> = {}): TraderStrategy {
  return {
    ...DEFAULT_STRATEGY,
    trusted_escrows: [TEST_ESCROW],
    ...overrides,
  };
}
