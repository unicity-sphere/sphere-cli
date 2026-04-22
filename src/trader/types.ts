/**
 * Trader Agent — core domain types and adapter interfaces.
 *
 * No Sphere SDK imports here: adapters are defined as narrow, DI-friendly
 * interfaces so the trader core stays testable with in-memory fakes.
 */

// =============================================================================
// Trading intents
// =============================================================================

export interface TradingIntent {
  readonly intent_id: string;
  readonly salt: string;
  readonly owner_pubkey: string;
  readonly offer_token: string;
  readonly offer_volume_min: bigint;
  readonly offer_volume_max: bigint;
  readonly request_token: string;
  readonly rate_min: bigint;
  readonly rate_max: bigint;
  readonly expiry_ms: number;
  readonly created_at_ms: number;
  readonly deposit_timeout_sec: number;
}

export type IntentState = 'ACTIVE' | 'PAUSED' | 'EXPIRED' | 'CANCELLED' | 'FILLED';

export interface IntentRecord {
  readonly intent: TradingIntent;
  state: IntentState;
  readonly market_listing_id: string | null;
  volume_filled: bigint;
  updated_at_ms: number;
}

// =============================================================================
// Deals
// =============================================================================

export interface DealTerms {
  readonly proposer_intent_id: string;
  readonly acceptor_intent_id: string;
  readonly proposer_pubkey: string;
  readonly acceptor_pubkey: string;
  readonly offer_token: string;
  readonly request_token: string;
  readonly offer_volume: bigint;
  readonly request_volume: bigint;
  readonly rate: bigint;
  readonly escrow_address: string;
  readonly deposit_timeout_sec: number;
}

export type DealState =
  | 'PROPOSED'
  | 'ACCEPTED'
  | 'EXECUTING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export interface DealRecord {
  readonly deal_id: string;
  readonly terms: DealTerms;
  state: DealState;
  readonly role: 'PROPOSER' | 'ACCEPTOR';
  readonly created_at_ms: number;
  updated_at_ms: number;
  failure_reason: string | null;
  // deposit_attempted is written BEFORE payInvoice() so crash-recovery can
  // tell the difference between "never paid" and "paid but never confirmed".
  deposit_attempted: boolean;
  payout_verified: boolean;
}

// =============================================================================
// Strategy
// =============================================================================

export interface TraderStrategy {
  readonly scan_interval_ms: number;
  readonly proposal_timeout_ms: number;
  readonly acceptance_timeout_ms: number;
  readonly max_active_intents: number;
  readonly trusted_escrows: readonly string[];
  readonly blocked_counterparties: readonly string[];
  readonly payout_poll_interval_ms: number;
  readonly payout_max_retries: number;
}

export const DEFAULT_STRATEGY: TraderStrategy = {
  scan_interval_ms: 30_000,
  proposal_timeout_ms: 30_000,
  acceptance_timeout_ms: 60_000,
  max_active_intents: 10,
  trusted_escrows: [],
  blocked_counterparties: [],
  payout_poll_interval_ms: 30_000,
  payout_max_retries: 10,
};

// =============================================================================
// Adapter interfaces (dependency injection seams)
// =============================================================================

export interface MarketListing {
  readonly listing_id: string;
  readonly description: string;
  readonly poster_pubkey: string;
  readonly expiry_ms: number;
}

export interface MarketAdapter {
  post(description: string, expiryMs: number): Promise<string>;
  remove(listingId: string): Promise<void>;
  search(query: string): Promise<MarketListing[]>;
  subscribeFeed(listener: (listing: MarketListing) => void): () => void;
  getRecentListings(): Promise<MarketListing[]>;
}

export interface SwapProposalParams {
  readonly escrowAddress: string;
  readonly offerToken: string;
  readonly offerVolume: bigint;
  readonly requestToken: string;
  readonly requestVolume: bigint;
  readonly depositTimeoutSec: number;
  readonly counterpartyAddress: string;
}

export interface SwapProposalResult {
  readonly swapId: string;
}

export interface SwapStatus {
  readonly swapId: string;
  readonly state: string;
  readonly payoutVerified?: boolean;
}

export interface SwapAdapter {
  propose(params: SwapProposalParams): Promise<SwapProposalResult>;
  accept(swapId: string): Promise<void>;
  getStatus(swapId: string): Promise<SwapStatus>;
  load(): Promise<void>;
  on(event: string, handler: (...args: unknown[]) => void): () => void;
}

export interface ActiveIntent {
  readonly listing_id: string;
  readonly description: string;
}

export interface PaymentsAdapter {
  receive(): Promise<{ address: string; pubkey: string }>;
  getMyIntents(): Promise<ActiveIntent[]>;
  payInvoice(invoice: string): Promise<void>;
  getConfirmedAmount(token: string): Promise<bigint>;
}

export interface IncomingDM {
  readonly senderPubkey: string;
  readonly content: string;
}

export interface CommsAdapter {
  sendDM(address: string, content: string): Promise<void>;
  onDirectMessage(handler: (msg: IncomingDM) => void): () => void;
}

// =============================================================================
// Callback types
// =============================================================================

export type OnMatchFound = (intent: IntentRecord, match: MarketListing) => void;
export type OnDealAccepted = (deal: DealRecord) => void;
export type OnSwapCompleted = (deal: DealRecord) => void;

// =============================================================================
// NP-0 Negotiation Protocol envelope
// =============================================================================

export type NpMessageType = 'np.propose' | 'np.accept' | 'np.reject' | 'np.cancel';

export interface NpMessage {
  readonly np_version: '0.1';
  readonly msg_id: string;
  readonly ts_ms: number;
  readonly sender_pubkey: string;
  readonly signature: string;
  readonly type: NpMessageType;
  readonly payload: Record<string, unknown>;
}
