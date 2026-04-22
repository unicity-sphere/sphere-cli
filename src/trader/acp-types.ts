/**
 * ACP-0 command param/result types for the Trader Agent.
 *
 * ACP boundary uses `number` for volumes/rates since JSON has no bigint type;
 * TraderCommandHandler converts to bigint internally. Volumes are serialised
 * as decimal strings on the way back out to preserve precision.
 */

export type TraderAcpCommand =
  | 'CREATE_INTENT'
  | 'CANCEL_INTENT'
  | 'LIST_INTENTS'
  | 'GET_INTENT'
  | 'UPDATE_STRATEGY'
  | 'GET_STRATEGY'
  | 'GET_DEALS';

// =============================================================================
// CREATE_INTENT
// =============================================================================

export interface CreateIntentParams {
  readonly offer_token: string;
  readonly offer_volume_min: number;
  readonly offer_volume_max: number;
  readonly request_token: string;
  readonly rate_min: number;
  readonly rate_max: number;
  readonly expiry_ms: number;
  readonly deposit_timeout_sec?: number;
}

export interface CreateIntentResult {
  readonly intent_id: string;
  readonly state: string;
}

// =============================================================================
// CANCEL_INTENT
// =============================================================================

export interface CancelIntentParams {
  readonly intent_id: string;
}

export interface CancelIntentResult {
  readonly intent_id: string;
  readonly state: 'CANCELLED';
}

// =============================================================================
// LIST_INTENTS
// =============================================================================

export interface ListIntentsParams {
  readonly state?: string;
}

export interface IntentSummary {
  readonly intent_id: string;
  readonly offer_token: string;
  readonly request_token: string;
  readonly state: string;
  readonly volume_filled: string;
  readonly offer_volume_max: string;
  readonly expiry_ms: number;
}

export interface ListIntentsResult {
  readonly intents: readonly IntentSummary[];
}

// =============================================================================
// GET_INTENT
// =============================================================================

export interface GetIntentParams {
  readonly intent_id: string;
}

export interface GetIntentResult {
  readonly record: IntentSummary & {
    readonly offer_volume_min: string;
    readonly rate_min: string;
    readonly rate_max: string;
    readonly market_listing_id: string | null;
    readonly updated_at_ms: number;
  };
}

// =============================================================================
// UPDATE_STRATEGY
// =============================================================================

export interface UpdateStrategyParams {
  readonly scan_interval_ms?: number;
  readonly proposal_timeout_ms?: number;
  readonly acceptance_timeout_ms?: number;
  readonly max_active_intents?: number;
  readonly trusted_escrows?: readonly string[];
  readonly blocked_counterparties?: readonly string[];
}

export interface UpdateStrategyResult {
  readonly ok: true;
}

// =============================================================================
// GET_STRATEGY
// =============================================================================

export type GetStrategyParams = Record<string, never>;

export interface GetStrategyResult {
  readonly strategy: {
    readonly scan_interval_ms: number;
    readonly proposal_timeout_ms: number;
    readonly acceptance_timeout_ms: number;
    readonly max_active_intents: number;
    readonly trusted_escrows: readonly string[];
    readonly blocked_counterparties: readonly string[];
  };
}

// =============================================================================
// GET_DEALS
// =============================================================================

export interface GetDealsParams {
  readonly intent_id?: string;
  readonly state?: string;
}

export interface DealSummary {
  readonly deal_id: string;
  readonly role: 'PROPOSER' | 'ACCEPTOR';
  readonly state: string;
  readonly offer_token: string;
  readonly request_token: string;
  readonly offer_volume: string;
  readonly request_volume: string;
  readonly created_at_ms: number;
  readonly failure_reason: string | null;
}

export interface GetDealsResult {
  readonly deals: readonly DealSummary[];
}
