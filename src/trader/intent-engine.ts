/**
 * IntentEngine — lifecycle management for trading intents.
 *
 * Responsibilities:
 *   - Publish new intents to the market (post description to MarketAdapter)
 *   - Scan the market for matching counterparty intents
 *   - Subscribe to the market feed for real-time match detection
 *   - Apply matching criteria (rate overlap, volume overlap, escrow trust, block list)
 *   - Decide who proposes (spec 5.7: lower pubkey proposes)
 *   - Enforce intent state machine (spec 6.1)
 *   - Handle deal completion/failure callbacks from the NegotiationHandler
 *   - Sweep expired intents
 *   - Clamp intent lifetime to 7 days (defence-in-depth; utils.validateIntent
 *     already enforces this at the ACP boundary)
 *
 * Design notes:
 *   - No Sphere SDK imports: adapters are injected via the constructor so the
 *     engine can be unit-tested with in-memory fakes.
 *   - Scan-loop errors are swallowed and logged to stderr so a transient market
 *     failure cannot crash the long-running trader process.
 *   - Feed-listing parse failures are silent on purpose: untrusted market input
 *     regularly contains free-form descriptions that do not match our encoding
 *     format, and noisy logs would drown out real errors.
 *   - Timers and the feed unsubscribe function are stored in instance fields so
 *     `stop()` can deterministically tear them down.
 */

import type {
  IntentRecord,
  IntentState,
  MarketAdapter,
  MarketListing,
  TraderStrategy,
  TradingIntent,
} from './types.js';
import type { DecodedDescription } from './utils.js';
import type { TraderStateStore } from './trader-state-store.js';
import type { VolumeReservationLedger } from './volume-reservation-ledger.js';

import { decodeDescription, encodeDescription } from './utils.js';

// =============================================================================
// Constants
// =============================================================================

/** Maximum lifetime for any intent (defence-in-depth; utils.validateIntent
 *  already enforces this at the ACP boundary). */
const MAX_INTENT_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/** Sweep cadence for expiring intents. Independent of the scan cadence so
 *  operators can tune scan frequency without affecting expiry latency. */
const EXPIRY_SWEEP_INTERVAL_MS = 10_000;

/** Debug-only logging: opt-in via the DEBUG env var. */
const DEBUG = typeof process !== 'undefined' && Boolean(process.env.DEBUG);

// =============================================================================
// State machine
// =============================================================================

/**
 * Valid IntentState transitions (spec 6.1).
 *
 * Any transition not listed here is rejected by `transitionState` and logged
 * to stderr. Terminal states (EXPIRED, CANCELLED, FILLED) have no outbound
 * edges — intents in those states are frozen.
 */
const VALID_TRANSITIONS: Readonly<Record<IntentState, readonly IntentState[]>> = {
  ACTIVE: ['PAUSED', 'CANCELLED', 'EXPIRED', 'FILLED'],
  PAUSED: ['ACTIVE', 'CANCELLED', 'EXPIRED'],
  EXPIRED: [],
  CANCELLED: [],
  FILLED: [],
};

// =============================================================================
// Public types
// =============================================================================

/**
 * Extended match event passed to the handler callback. Carries the decoded
 * description (parsed once at match time so downstream code does not need to
 * re-parse) and the `shouldPropose` decision so the NegotiationHandler knows
 * whether to initiate the proposal or wait for the counterparty.
 */
export interface MatchEvent {
  readonly intent: IntentRecord;
  readonly listing: MarketListing;
  readonly shouldPropose: boolean;
  readonly decoded: DecodedDescription;
}

/**
 * Fields of a TradingIntent that can be updated after creation. Monotonic by
 * spec 2.7.3: rate_min can only increase, rate_max only decrease, and
 * offer_volume_min can only increase. These constraints are enforced in
 * {@link IntentEngine.updateIntent}.
 */
export type IntentUpdate = Partial<
  Pick<TradingIntent, 'rate_min' | 'rate_max' | 'offer_volume_min'>
>;

// =============================================================================
// IntentEngine
// =============================================================================

export class IntentEngine {
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private feedUnsubscribe: (() => void) | null = null;
  private started = false;

  constructor(
    private readonly store: TraderStateStore,
    private readonly market: MarketAdapter,
    private readonly ledger: VolumeReservationLedger,
    private readonly strategy: () => TraderStrategy,
    private readonly myPubkey: string,
    private readonly onMatchFound: (event: MatchEvent) => void,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start the engine. Idempotent: a second call is a no-op.
   *
   * Re-publishes any ACTIVE intents that lost their market_listing_id across a
   * restart — the market is an external system and listings are not guaranteed
   * to survive our downtime.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const intents = this.store.getAllIntents();
    for (const record of intents) {
      if (record.state === 'ACTIVE' && record.market_listing_id === null) {
        await this.repostIntent(record);
      }
    }

    this.sweepTimer = setInterval(() => {
      void this.sweepExpired().catch((err) => {
        process.stderr.write(
          `IntentEngine: sweep failed: ${(err as Error).message}\n`,
        );
      });
    }, EXPIRY_SWEEP_INTERVAL_MS);

    const scanIntervalMs = Math.max(1_000, this.strategy().scan_interval_ms);
    this.scanTimer = setInterval(() => {
      void this.scanOnce().catch((err) => {
        process.stderr.write(
          `IntentEngine: scan failed: ${(err as Error).message}\n`,
        );
      });
    }, scanIntervalMs);

    this.feedUnsubscribe = this.market.subscribeFeed((listing) => {
      this.handleFeedListing(listing);
    });
  }

  /**
   * Stop the engine. Clears timers, unsubscribes the feed, removes ACTIVE
   * listings from the market (fire-and-forget), and persists state.
   *
   * `stop()` does not throw on market errors: the caller typically invokes it
   * during shutdown where throwing would mask the primary shutdown reason.
   */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.scanTimer !== null) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    if (this.feedUnsubscribe !== null) {
      try {
        this.feedUnsubscribe();
      } catch (err) {
        if (DEBUG) {
          process.stderr.write(
            `IntentEngine: feed unsubscribe failed: ${(err as Error).message}\n`,
          );
        }
      }
      this.feedUnsubscribe = null;
    }

    const active = this.store.getAllIntents().filter((r) => r.state === 'ACTIVE');
    for (const record of active) {
      if (record.market_listing_id !== null) {
        // Fire-and-forget: logs on failure but does not throw.
        this.removeListingSafely(record.market_listing_id);
      }
    }

    try {
      await this.store.save();
    } catch (err) {
      process.stderr.write(
        `IntentEngine: save on stop failed: ${(err as Error).message}\n`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Intent CRUD
  // ---------------------------------------------------------------------------

  /**
   * Create and publish a new intent.
   *
   * Clamps `expiry_ms` to at most 7 days from now (spec max lifetime). The
   * validation at the ACP boundary already enforces this, so clamping here is
   * defence-in-depth — it also lets internal callers create intents without
   * replicating the bound check.
   */
  async createIntent(intent: TradingIntent): Promise<IntentRecord> {
    const now = Date.now();
    const maxExpiry = now + MAX_INTENT_LIFETIME_MS;
    const clampedExpiry = Math.min(intent.expiry_ms, maxExpiry);
    const effectiveIntent: TradingIntent =
      clampedExpiry === intent.expiry_ms
        ? intent
        : { ...intent, expiry_ms: clampedExpiry };

    const listingId = await this.postListing(effectiveIntent);

    const record: IntentRecord = {
      intent: effectiveIntent,
      state: 'ACTIVE',
      market_listing_id: listingId,
      volume_filled: 0n,
      updated_at_ms: now,
    };

    this.store.setIntent(record);
    await this.store.save();
    return record;
  }

  /** Transition an ACTIVE or PAUSED intent to CANCELLED and remove its listing. */
  async cancelIntent(intentId: string): Promise<IntentRecord> {
    const record = this.requireIntent(intentId);
    const updated = this.transitionState(record, 'CANCELLED');
    if (record.market_listing_id !== null) {
      this.removeListingSafely(record.market_listing_id);
    }
    const next: IntentRecord = {
      ...updated,
      market_listing_id: null,
    };
    this.store.setIntent(next);
    await this.store.save();
    return next;
  }

  /** Transition ACTIVE → PAUSED. Listing is removed so counterparties do not
   *  waste proposals on a paused intent. */
  async pauseIntent(intentId: string): Promise<IntentRecord> {
    const record = this.requireIntent(intentId);
    const updated = this.transitionState(record, 'PAUSED');
    if (record.market_listing_id !== null) {
      this.removeListingSafely(record.market_listing_id);
    }
    const next: IntentRecord = {
      ...updated,
      market_listing_id: null,
    };
    this.store.setIntent(next);
    await this.store.save();
    return next;
  }

  /** Transition PAUSED → ACTIVE. Re-publishes the listing to the market. */
  async resumeIntent(intentId: string): Promise<IntentRecord> {
    const record = this.requireIntent(intentId);
    const updated = this.transitionState(record, 'ACTIVE');
    const listingId = await this.postListing(updated.intent);
    const next: IntentRecord = {
      ...updated,
      market_listing_id: listingId,
    };
    this.store.setIntent(next);
    await this.store.save();
    return next;
  }

  /**
   * Update mutable terms on an existing intent. Monotonic constraints are
   * enforced here and in spec 2.7.3:
   *   - `rate_min` can only increase
   *   - `rate_max` can only decrease
   *   - `offer_volume_min` can only increase
   *
   * If the intent is ACTIVE, the old listing is removed and a new one posted
   * with the updated terms.
   */
  async updateIntent(intentId: string, updates: IntentUpdate): Promise<IntentRecord> {
    const record = this.requireIntent(intentId);
    if (record.state !== 'ACTIVE' && record.state !== 'PAUSED') {
      throw new Error(
        `IntentEngine: cannot update intent ${intentId} in state ${record.state}`,
      );
    }

    const old = record.intent;
    const nextRateMin = updates.rate_min ?? old.rate_min;
    const nextRateMax = updates.rate_max ?? old.rate_max;
    const nextVolMin = updates.offer_volume_min ?? old.offer_volume_min;

    if (updates.rate_min !== undefined && updates.rate_min < old.rate_min) {
      throw new Error(
        `IntentEngine: rate_min is monotonically increasing (old=${old.rate_min}, new=${updates.rate_min})`,
      );
    }
    if (updates.rate_max !== undefined && updates.rate_max > old.rate_max) {
      throw new Error(
        `IntentEngine: rate_max is monotonically decreasing (old=${old.rate_max}, new=${updates.rate_max})`,
      );
    }
    if (updates.offer_volume_min !== undefined && updates.offer_volume_min < old.offer_volume_min) {
      throw new Error(
        `IntentEngine: offer_volume_min is monotonically increasing (old=${old.offer_volume_min}, new=${updates.offer_volume_min})`,
      );
    }
    if (nextRateMin > nextRateMax) {
      throw new Error(
        `IntentEngine: after update rate_min (${nextRateMin}) > rate_max (${nextRateMax})`,
      );
    }
    if (nextVolMin > old.offer_volume_max) {
      throw new Error(
        `IntentEngine: after update offer_volume_min (${nextVolMin}) > offer_volume_max (${old.offer_volume_max})`,
      );
    }

    const nextIntent: TradingIntent = {
      ...old,
      rate_min: nextRateMin,
      rate_max: nextRateMax,
      offer_volume_min: nextVolMin,
    };

    // Remove old listing before posting the new one so the market never shows
    // two conflicting entries for the same intent_id.
    if (record.market_listing_id !== null) {
      this.removeListingSafely(record.market_listing_id);
    }

    let newListingId: string | null = null;
    if (record.state === 'ACTIVE') {
      newListingId = await this.postListing(nextIntent);
    }

    const next: IntentRecord = {
      intent: nextIntent,
      state: record.state,
      market_listing_id: newListingId,
      volume_filled: record.volume_filled,
      updated_at_ms: Date.now(),
    };
    this.store.setIntent(next);
    await this.store.save();
    return next;
  }

  // ---------------------------------------------------------------------------
  // Deal outcome callbacks
  // ---------------------------------------------------------------------------

  /**
   * Record a successful deal against the intent. If the accumulated
   * `volume_filled` reaches `offer_volume_max`, transition the intent to
   * FILLED and remove its listing. Otherwise the intent stays ACTIVE so the
   * scan loop continues to seek more counterparties.
   */
  async onDealCompleted(intentId: string, volumeFilled: bigint): Promise<void> {
    const record = this.store.getIntent(intentId);
    if (!record) {
      process.stderr.write(
        `IntentEngine: onDealCompleted for unknown intent ${intentId}\n`,
      );
      return;
    }
    if (volumeFilled < 0n) {
      throw new Error(
        `IntentEngine: onDealCompleted requires non-negative volumeFilled, got ${volumeFilled}`,
      );
    }

    const nextFilled = record.volume_filled + volumeFilled;

    if (record.state === 'FILLED' || record.state === 'CANCELLED' || record.state === 'EXPIRED') {
      // Terminal states do not accept further fills; record the event but do
      // not attempt another state transition.
      const next: IntentRecord = {
        ...record,
        volume_filled: nextFilled,
        updated_at_ms: Date.now(),
      };
      this.store.setIntent(next);
      await this.store.save();
      return;
    }

    if (nextFilled >= record.intent.offer_volume_max) {
      const transitioned = this.transitionState(record, 'FILLED');
      if (record.market_listing_id !== null) {
        this.removeListingSafely(record.market_listing_id);
      }
      const next: IntentRecord = {
        ...transitioned,
        market_listing_id: null,
        volume_filled: nextFilled,
      };
      this.store.setIntent(next);
    } else {
      const next: IntentRecord = {
        ...record,
        volume_filled: nextFilled,
        updated_at_ms: Date.now(),
      };
      this.store.setIntent(next);
    }
    await this.store.save();
  }

  /**
   * Record a failed deal. The intent state is not changed — a failed deal is
   * not a reason to retire an intent. Persist so `updated_at_ms` and any
   * concurrently-updated fields are flushed to disk.
   */
  async onDealFailed(intentId: string): Promise<void> {
    const record = this.store.getIntent(intentId);
    if (!record) {
      process.stderr.write(
        `IntentEngine: onDealFailed for unknown intent ${intentId}\n`,
      );
      return;
    }
    const next: IntentRecord = {
      ...record,
      updated_at_ms: Date.now(),
    };
    this.store.setIntent(next);
    await this.store.save();
  }

  // ---------------------------------------------------------------------------
  // Read-only accessors
  // ---------------------------------------------------------------------------

  getIntent(intentId: string): IntentRecord | undefined {
    return this.store.getIntent(intentId);
  }

  getAllIntents(): IntentRecord[] {
    return this.store.getAllIntents();
  }

  // ---------------------------------------------------------------------------
  // Scan loop
  // ---------------------------------------------------------------------------

  /**
   * Run one scan iteration: for each ACTIVE intent, search the market for the
   * token pair and evaluate each listing against the intent's criteria. Logs
   * transient adapter errors to stderr but never rethrows — the scan timer
   * fires again on the next tick.
   */
  private async scanOnce(): Promise<void> {
    if (!this.started) return;

    const active = this.store.getAllIntents().filter((r) => r.state === 'ACTIVE');
    const strategy = this.strategy();

    for (const record of active) {
      const query = `${record.intent.offer_token} ${record.intent.request_token}`;
      let listings: MarketListing[];
      try {
        listings = await this.market.search(query);
      } catch (err) {
        process.stderr.write(
          `IntentEngine: market.search failed for "${query}": ${(err as Error).message}\n`,
        );
        continue;
      }

      for (const listing of listings) {
        this.evaluateListing(record, listing, strategy);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Feed handler
  // ---------------------------------------------------------------------------

  /**
   * Called for every listing pushed by `market.subscribeFeed`. Matches against
   * every ACTIVE intent whose token pair is the inverse of the listing's pair,
   * since the listing's offer is our request and vice versa.
   *
   * Errors raised inside the match handler are caught so a bad listener never
   * tears down the market subscription.
   */
  private handleFeedListing(listing: MarketListing): void {
    try {
      const decoded = decodeDescription(listing.description);
      if (decoded === null) return;

      const strategy = this.strategy();
      const active = this.store.getAllIntents().filter((r) => r.state === 'ACTIVE');

      for (const record of active) {
        if (
          record.intent.request_token !== decoded.offer_token ||
          record.intent.offer_token !== decoded.request_token
        ) {
          continue;
        }
        if (this.matchesCriteria(record, decoded, listing, strategy)) {
          this.emitMatch(record, listing, decoded);
        }
      }
    } catch (err) {
      process.stderr.write(
        `IntentEngine: feed handler error: ${(err as Error).message}\n`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Matching logic
  // ---------------------------------------------------------------------------

  /**
   * Evaluate a single listing against an intent. Silently skips listings with
   * malformed descriptions — the market is full of them and logging would
   * produce mostly noise.
   */
  private evaluateListing(
    record: IntentRecord,
    listing: MarketListing,
    strategy: TraderStrategy,
  ): void {
    const decoded = decodeDescription(listing.description);
    if (decoded === null) return;

    // Cross-check the decoded token pair against the intent's inverse. The
    // market.search query is a loose text match; this is the authoritative check.
    if (
      record.intent.request_token !== decoded.offer_token ||
      record.intent.offer_token !== decoded.request_token
    ) {
      return;
    }

    if (this.matchesCriteria(record, decoded, listing, strategy)) {
      this.emitMatch(record, listing, decoded);
    }
  }

  /**
   * Full matching predicate. Returns true iff every criterion in spec 5.x
   * holds. The checks are ordered cheap-to-expensive so mismatched listings
   * fail fast.
   */
  private matchesCriteria(
    record: IntentRecord,
    decoded: DecodedDescription,
    listing: MarketListing,
    strategy: TraderStrategy,
  ): boolean {
    // 1. Listing not expired.
    if (listing.expiry_ms <= Date.now()) return false;

    // 2. Not our own listing.
    if (listing.poster_pubkey === this.myPubkey) return false;

    // 3-4. Token pair matches (caller already checked but keep here for the
    //       filterMatches path where this method is used directly).
    if (decoded.offer_token !== record.intent.request_token) return false;
    if (decoded.request_token !== record.intent.offer_token) return false;

    // 5-6. Rate overlap. Their rate describes how much of `decoded.offer_token`
    //       (= our request_token) they will give per unit of `decoded.request_token`
    //       (= our offer_token). Our intent's rate range is expressed in the same
    //       units, so overlap is a direct interval intersection.
    if (decoded.rate_min > record.intent.rate_max) return false;
    if (decoded.rate_max < record.intent.rate_min) return false;

    // 7. Their max offer volume is at least our min offer volume. Volumes are
    //     in units of the posting side's offer token, so we translate through
    //     `volume_min <= listing.offer_volume_max`.
    if (decoded.offer_volume_max < record.intent.offer_volume_min) return false;

    // 8. Their min offer volume fits within our remaining capacity.
    const remaining = record.intent.offer_volume_max - record.volume_filled;
    if (remaining <= 0n) return false;
    if (decoded.offer_volume_min > remaining) return false;

    // 9. Counterparty is not on our block list.
    if (strategy.blocked_counterparties.includes(listing.poster_pubkey)) return false;

    // 10. At least one advertised escrow is in our trust set.
    if (!this.hasTrustedEscrow(decoded.escrows, strategy.trusted_escrows)) return false;

    return true;
  }

  /**
   * Public-ish filter used by callers that want to evaluate a batch of
   * listings without driving the scan loop. Exposed on the instance so tests
   * can exercise the matching logic in isolation.
   */
  filterMatches(record: IntentRecord, listings: readonly MarketListing[]): MarketListing[] {
    const strategy = this.strategy();
    const out: MarketListing[] = [];
    for (const listing of listings) {
      const decoded = decodeDescription(listing.description);
      if (decoded === null) continue;
      if (
        record.intent.request_token !== decoded.offer_token ||
        record.intent.offer_token !== decoded.request_token
      ) {
        continue;
      }
      if (this.matchesCriteria(record, decoded, listing, strategy)) {
        out.push(listing);
      }
    }
    return out;
  }

  private hasTrustedEscrow(
    offered: readonly string[],
    trusted: readonly string[],
  ): boolean {
    if (trusted.length === 0) return false;
    const trustSet = new Set(trusted);
    for (const escrow of offered) {
      if (trustSet.has(escrow)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Proposer selection (spec 5.7)
  // ---------------------------------------------------------------------------

  /**
   * Deterministic proposer selection: the party with the lexicographically
   * lower secp256k1 pubkey proposes; the other waits. This avoids the case
   * where both sides fire proposals simultaneously and then have to reconcile
   * duplicates.
   *
   * Comparing hex-encoded pubkeys as strings is well-defined because both
   * sides agree on the canonical hex encoding (lowercase, fixed width).
   */
  private shouldPropose(counterpartyPubkey: string): boolean {
    return this.myPubkey < counterpartyPubkey;
  }

  private emitMatch(
    record: IntentRecord,
    listing: MarketListing,
    decoded: DecodedDescription,
  ): void {
    const event: MatchEvent = {
      intent: record,
      listing,
      shouldPropose: this.shouldPropose(listing.poster_pubkey),
      decoded,
    };
    try {
      this.onMatchFound(event);
    } catch (err) {
      process.stderr.write(
        `IntentEngine: onMatchFound handler threw: ${(err as Error).message}\n`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Expiry sweep
  // ---------------------------------------------------------------------------

  /**
   * Mark any ACTIVE or PAUSED intent whose `expiry_ms` has passed as EXPIRED.
   * Persists at most once per sweep regardless of the number of expirations.
   */
  private async sweepExpired(): Promise<void> {
    if (!this.started) return;

    const now = Date.now();
    const candidates = this.store
      .getAllIntents()
      .filter((r) => (r.state === 'ACTIVE' || r.state === 'PAUSED') && r.intent.expiry_ms <= now);

    if (candidates.length === 0) return;

    for (const record of candidates) {
      try {
        const transitioned = this.transitionState(record, 'EXPIRED');
        if (record.market_listing_id !== null) {
          this.removeListingSafely(record.market_listing_id);
        }
        const next: IntentRecord = {
          ...transitioned,
          market_listing_id: null,
        };
        this.store.setIntent(next);
      } catch (err) {
        process.stderr.write(
          `IntentEngine: expiry transition failed for ${record.intent.intent_id}: ${(err as Error).message}\n`,
        );
      }
    }

    try {
      await this.store.save();
    } catch (err) {
      process.stderr.write(
        `IntentEngine: save after sweep failed: ${(err as Error).message}\n`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // State transitions
  // ---------------------------------------------------------------------------

  /**
   * Apply a state transition with validation. Returns a new IntentRecord with
   * the updated state and refreshed `updated_at_ms`. Throws (and logs) if the
   * transition is not allowed by the state machine.
   */
  private transitionState(record: IntentRecord, next: IntentState): IntentRecord {
    const allowed = VALID_TRANSITIONS[record.state];
    if (!allowed.includes(next)) {
      const msg = `IntentEngine: invalid transition ${record.state} -> ${next} for intent ${record.intent.intent_id}`;
      process.stderr.write(`${msg}\n`);
      throw new Error(msg);
    }
    return {
      ...record,
      state: next,
      updated_at_ms: Date.now(),
    };
  }

  private requireIntent(intentId: string): IntentRecord {
    const record = this.store.getIntent(intentId);
    if (!record) {
      throw new Error(`IntentEngine: unknown intent ${intentId}`);
    }
    return record;
  }

  // ---------------------------------------------------------------------------
  // Market-listing helpers
  // ---------------------------------------------------------------------------

  /**
   * Post the intent's description to the market and return the listing id.
   * Uses the strategy's trusted escrows as the advertised escrow set — this
   * is the set counterparties must intersect to match us, so we advertise the
   * whole set up front rather than revealing escrow preference during
   * negotiation.
   */
  private async postListing(intent: TradingIntent): Promise<string> {
    const escrows = this.strategy().trusted_escrows;
    const description = encodeDescription(intent, escrows);
    return this.market.post(description, intent.expiry_ms);
  }

  /**
   * Re-post an ACTIVE intent that lost its listing across a restart. The
   * IntentRecord is updated in place with the new listing id.
   */
  private async repostIntent(record: IntentRecord): Promise<void> {
    try {
      const listingId = await this.postListing(record.intent);
      const next: IntentRecord = {
        ...record,
        market_listing_id: listingId,
        updated_at_ms: Date.now(),
      };
      this.store.setIntent(next);
      await this.store.save();
    } catch (err) {
      process.stderr.write(
        `IntentEngine: repost failed for ${record.intent.intent_id}: ${(err as Error).message}\n`,
      );
    }
  }

  /**
   * Fire-and-forget listing removal. We never want a market error to crash a
   * cancel/pause/expire flow — the listing will eventually expire from the
   * market on its own even if our remove() call is lost.
   *
   * Intentionally returns void: callers do not await. Uses `void` on the
   * promise chain so unhandled-rejection linters do not flag it.
   */
  private removeListingSafely(listingId: string): void {
    // Use a catch handler attached synchronously so a rejected promise never
    // becomes an unhandled rejection on the event loop. Intentionally not
    // awaited — callers do not want to block on market I/O during teardown.
    void (async () => {
      try {
        await this.market.remove(listingId);
      } catch (err) {
        if (DEBUG) {
          process.stderr.write(
            `IntentEngine: market.remove(${listingId}) failed: ${(err as Error).message}\n`,
          );
        }
      }
    })();
  }

  // ---------------------------------------------------------------------------
  // Ledger access for deal-accept path (surface point for future integrations)
  // ---------------------------------------------------------------------------

  /**
   * Expose the underlying ledger so the NegotiationHandler can reserve volume
   * against the confirmed balance without reaching around the engine. Intents
   * and reservations live at the same abstraction level; sharing the ledger
   * through the engine keeps the constructor surface of downstream components
   * small.
   */
  getLedger(): VolumeReservationLedger {
    return this.ledger;
  }
}
