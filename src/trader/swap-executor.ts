/**
 * SwapExecutor — drives the swap lifecycle from ACCEPTED → EXECUTING →
 * COMPLETED/FAILED.
 *
 * Responsibilities:
 *   - Kick off escrow deposit payment when we are the PROPOSER.
 *   - Listen to sphere swap events and advance the deal's state machine.
 *   - Enforce V2 protocol requirement (spec 7.9.5), trusted escrows (spec
 *     7.9.1), term binding (spec 7.9.4), and payout verification before
 *     declaring COMPLETED (spec 7.9.2).
 *   - Apply an EXECUTING-state timeout so a stalled swap never wedges
 *     reserved volume.
 *   - Release `VolumeReservationLedger` entries on terminal transitions.
 *
 * Design notes:
 *   - `deposit_attempted` is written BEFORE `payInvoice()` so crash-recovery
 *     can distinguish "never paid" from "paid but not confirmed yet".
 *   - All sphere-event handlers are wrapped in try/catch: a malformed event
 *     from the SDK must not crash the long-running trader process.
 *   - No Sphere SDK imports — the executor only consumes the narrow
 *     {@link SwapAdapter} / {@link PaymentsAdapter} DI seams.
 */

import type {
  DealRecord,
  DealTerms,
  OnSwapCompleted,
  PaymentsAdapter,
  SwapAdapter,
  TraderStrategy,
} from './types.js';
import type { TraderStateStore } from './trader-state-store.js';
import type { VolumeReservationLedger } from './volume-reservation-ledger.js';

// =============================================================================
// Constants
// =============================================================================

/** Debug logging opt-in (mirrors NegotiationHandler). */
const DEBUG = typeof process !== 'undefined' && Boolean(process.env['DEBUG']);

/** Required sphere swap protocol version (spec 7.9.5). */
const REQUIRED_PROTOCOL_VERSION = 2;

/** Extra grace window added on top of `deposit_timeout_sec` for the
 *  EXECUTING-state watchdog. */
const EXECUTING_TIMEOUT_GRACE_SEC = 60;

// =============================================================================
// Helpers
// =============================================================================

/** Terminal states — no further transitions permitted. */
function isTerminalState(state: DealRecord['state']): boolean {
  return state === 'COMPLETED' || state === 'FAILED' || state === 'CANCELLED';
}

/**
 * Derive the escrow "invoice" from DealTerms. The MVP treats the escrow
 * address as the direct transfer destination — a full implementation would
 * construct a protocol-specific payment request.
 */
function escrowInvoice(terms: DealTerms): string {
  return terms.escrow_address;
}

/** Best-effort bigint parser from swap-event payload fields. */
function asBigInt(v: unknown): bigint | null {
  try {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
    if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
    return null;
  } catch {
    return null;
  }
}

// =============================================================================
// SwapExecutor
// =============================================================================

export class SwapExecutor {
  private started = false;

  /** Unsubscribe functions returned by `sphereOn(...)` — called on `stop()`. */
  private readonly eventUnsubs: Array<() => void> = [];

  /** dealId -> EXECUTING-state watchdog handle. */
  private readonly executingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Mapping swapId <-> dealId so event handlers can resolve deals. */
  private readonly dealToSwap = new Map<string, string>();
  private readonly swapToDeal = new Map<string, string>();

  constructor(
    private readonly store: TraderStateStore,
    private readonly swap: SwapAdapter,
    private readonly payments: PaymentsAdapter,
    private readonly ledger: VolumeReservationLedger,
    private readonly strategy: () => TraderStrategy,
    private readonly onSwapCompleted: OnSwapCompleted,
    private readonly sphereOn: (
      event: string,
      handler: (...args: unknown[]) => void,
    ) => () => void,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // 1. Reconcile swap state from the SDK before subscribing so any events
    //    replayed during `load()` are captured by our listeners.
    try {
      await this.swap.load();
    } catch (err) {
      process.stderr.write(
        `SwapExecutor: swap.load failed: ${(err as Error).message}\n`,
      );
    }

    // 2. Subscribe to all swap lifecycle events.
    this.subscribe('swap:proposal_received', (args) => this.onProposalReceived(args));
    this.subscribe('swap:accepted', (args) => this.onAccepted(args));
    this.subscribe('swap:announced', (args) => this.onAnnounced(args));
    this.subscribe('swap:deposit_sent', (args) => this.onDepositSent(args));
    this.subscribe('swap:deposit_confirmed', (args) => this.onDepositConfirmed(args));
    this.subscribe('swap:completed', (args) => this.onCompleted(args));
    this.subscribe('swap:failed', (args) => this.onFailed(args));
    this.subscribe('swap:cancelled', (args) => this.onCancelled(args));

    // 3. Recover any in-flight EXECUTING deals from the store so their
    //    watchdog timers are re-armed after a restart.
    for (const deal of this.store.getAllDeals()) {
      if (deal.state === 'EXECUTING') {
        this.setExecutingTimeout(deal);
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    for (const unsub of this.eventUnsubs) {
      try {
        unsub();
      } catch {
        // tearing down — swallow
      }
    }
    this.eventUnsubs.length = 0;

    for (const timer of this.executingTimers.values()) {
      clearTimeout(timer);
    }
    this.executingTimers.clear();
  }

  // ---------------------------------------------------------------------------
  // Read-only accessors
  // ---------------------------------------------------------------------------

  getDeal(dealId: string): DealRecord | undefined {
    return this.store.getDeal(dealId);
  }

  // ---------------------------------------------------------------------------
  // Execute: ACCEPTED -> EXECUTING (and kick off deposit if PROPOSER)
  // ---------------------------------------------------------------------------

  /**
   * Transition an ACCEPTED deal into EXECUTING and — if we are the PROPOSER —
   * pay the escrow invoice. Throws synchronously on precondition failures so
   * the caller (NegotiationHandler → onDealAccepted bridge) sees the error.
   */
  async execute(deal: DealRecord): Promise<void> {
    if (deal.state !== 'ACCEPTED') {
      throw new Error(
        `SwapExecutor.execute: deal ${deal.deal_id} is in state ${deal.state}, expected ACCEPTED`,
      );
    }

    // Verify trusted escrow (spec 7.9.1) before committing to EXECUTING.
    await this.pingEscrow(deal);

    // Transition to EXECUTING and persist before any network-visible side
    // effect. That way, crash-recovery observes a consistent state.
    const now = Date.now();
    deal.state = 'EXECUTING';
    deal.updated_at_ms = now;
    this.store.setDeal(deal);
    await this.saveSafely();

    this.setExecutingTimeout(deal);

    if (deal.role === 'PROPOSER') {
      // Record deposit_attempted BEFORE payInvoice so a crash mid-call cannot
      // produce "money left but no record".
      deal.deposit_attempted = true;
      deal.updated_at_ms = Date.now();
      this.store.setDeal(deal);
      await this.saveSafely();

      try {
        await this.payments.payInvoice(escrowInvoice(deal.terms));
      } catch (err) {
        process.stderr.write(
          `SwapExecutor: payInvoice failed for ${deal.deal_id}: ${(err as Error).message}\n`,
        );
        await this.failDeal(deal, `PAY_INVOICE_FAILED:${(err as Error).message}`);
        return;
      }
    }

    // ACCEPTOR side and post-payment PROPOSER side both wait for sphere
    // events (deposit_confirmed, completed, etc.) to drive the rest.
  }

  // ---------------------------------------------------------------------------
  // Escrow reachability check (spec 7.9.1)
  // ---------------------------------------------------------------------------

  private async pingEscrow(deal: DealRecord): Promise<void> {
    const strategy = this.strategy();
    if (!strategy.trusted_escrows.includes(deal.terms.escrow_address)) {
      throw new Error(
        `ESCROW_UNREACHABLE: ${deal.terms.escrow_address} not in trusted_escrows`,
      );
    }
    // For MVP: trust check is sufficient. A real impl would send an
    // ICMP-style probe here.
  }

  // ---------------------------------------------------------------------------
  // Sphere event subscription helper
  // ---------------------------------------------------------------------------

  private subscribe(
    event: string,
    handler: (args: Record<string, unknown>) => void | Promise<void>,
  ): void {
    const unsub = this.sphereOn(event, (...rawArgs: unknown[]) => {
      try {
        const first = rawArgs[0];
        const args: Record<string, unknown> =
          first && typeof first === 'object' && !Array.isArray(first)
            ? (first as Record<string, unknown>)
            : {};
        const result = handler(args);
        if (result instanceof Promise) {
          result.catch((err) => {
            process.stderr.write(
              `SwapExecutor: async handler ${event} threw: ${(err as Error).message}\n`,
            );
          });
        }
      } catch (err) {
        process.stderr.write(
          `SwapExecutor: handler ${event} threw: ${(err as Error).message}\n`,
        );
      }
    });
    this.eventUnsubs.push(unsub);
  }

  private resolveDealFromArgs(args: Record<string, unknown>): DealRecord | null {
    const swapId = typeof args['swapId'] === 'string' ? (args['swapId'] as string) : null;
    if (!swapId) return null;
    const dealId = this.swapToDeal.get(swapId);
    if (!dealId) return null;
    return this.store.getDeal(dealId) ?? null;
  }

  // ---------------------------------------------------------------------------
  // swap:proposal_received — V2 enforcement + term binding + escrow match
  // ---------------------------------------------------------------------------

  private async onProposalReceived(args: Record<string, unknown>): Promise<void> {
    const swapId = typeof args['swapId'] === 'string' ? (args['swapId'] as string) : null;
    const dealId = typeof args['dealId'] === 'string' ? (args['dealId'] as string) : null;
    if (!swapId || !dealId) {
      if (DEBUG) {
        process.stderr.write('SwapExecutor: proposal_received missing swapId/dealId\n');
      }
      return;
    }

    const deal = this.store.getDeal(dealId);
    if (!deal) {
      if (DEBUG) {
        process.stderr.write(
          `SwapExecutor: proposal_received for unknown deal ${dealId}\n`,
        );
      }
      return;
    }
    if (isTerminalState(deal.state)) return;

    // Register the swapId↔dealId mapping for future events.
    this.dealToSwap.set(dealId, swapId);
    this.swapToDeal.set(swapId, dealId);

    // V2 enforcement (spec 7.9.5).
    const protocolVersion = args['protocolVersion'];
    if (protocolVersion !== REQUIRED_PROTOCOL_VERSION) {
      await this.failDeal(deal, 'V2_REQUIRED');
      return;
    }

    // Trusted-escrow cross-check (spec 7.9.1): the swap's escrow must match
    // the one we negotiated. A counterparty who quietly swaps in a different
    // escrow address after negotiation is compromised.
    const escrowAddress =
      typeof args['escrowAddress'] === 'string' ? (args['escrowAddress'] as string) : null;
    if (escrowAddress !== null && escrowAddress !== deal.terms.escrow_address) {
      await this.failDeal(deal, 'ESCROW_MISMATCH');
      return;
    }

    // Term binding (spec 7.9.4): offer/request tokens and volumes MUST match
    // what we agreed to in NP-0 negotiation.
    if (!this.termsMatch(deal.terms, args)) {
      await this.failDeal(deal, 'TERMS_MISMATCH');
      return;
    }
  }

  /**
   * Compare incoming swap-proposal args against the deal's DealTerms. Any
   * field absent from `args` is treated as a mismatch rather than silently
   * accepted — fail-closed.
   */
  private termsMatch(terms: DealTerms, args: Record<string, unknown>): boolean {
    if (args['offer_token'] !== terms.offer_token) return false;
    if (args['request_token'] !== terms.request_token) return false;

    const offer = asBigInt(args['offer_volume']);
    if (offer === null || offer !== terms.offer_volume) return false;

    const request = asBigInt(args['request_volume']);
    if (request === null || request !== terms.request_volume) return false;

    return true;
  }

  // ---------------------------------------------------------------------------
  // Lightweight log handlers
  // ---------------------------------------------------------------------------

  private onAccepted(args: Record<string, unknown>): void {
    if (DEBUG) {
      process.stderr.write(`SwapExecutor: swap:accepted ${JSON.stringify(args)}\n`);
    }
  }

  private onAnnounced(args: Record<string, unknown>): void {
    if (DEBUG) {
      process.stderr.write(`SwapExecutor: swap:announced ${JSON.stringify(args)}\n`);
    }
  }

  private onDepositSent(args: Record<string, unknown>): void {
    if (DEBUG) {
      process.stderr.write(`SwapExecutor: swap:deposit_sent ${JSON.stringify(args)}\n`);
    }
  }

  // ---------------------------------------------------------------------------
  // swap:deposit_confirmed — begin payout polling
  // ---------------------------------------------------------------------------

  private async onDepositConfirmed(args: Record<string, unknown>): Promise<void> {
    const deal = this.resolveDealFromArgs(args);
    if (!deal) return;
    if (isTerminalState(deal.state)) return;
    const swapId = this.dealToSwap.get(deal.deal_id);
    if (!swapId) return;

    const verified = await this.verifyPayout(deal, swapId);
    if (verified) {
      await this.completeDeal(deal, deal.terms.offer_volume);
    } else {
      await this.failDeal(deal, 'PAYOUT_UNVERIFIED');
    }
  }

  // ---------------------------------------------------------------------------
  // swap:completed — verify payout before declaring COMPLETED (spec 7.9.2)
  // ---------------------------------------------------------------------------

  private async onCompleted(args: Record<string, unknown>): Promise<void> {
    const deal = this.resolveDealFromArgs(args);
    if (!deal) return;
    if (isTerminalState(deal.state)) return;
    const swapId = this.dealToSwap.get(deal.deal_id);
    if (!swapId) return;

    const verified = await this.verifyPayout(deal, swapId);
    if (verified) {
      await this.completeDeal(deal, deal.terms.offer_volume);
    } else {
      await this.failDeal(deal, 'PAYOUT_UNVERIFIED');
    }
  }

  private async onFailed(args: Record<string, unknown>): Promise<void> {
    const deal = this.resolveDealFromArgs(args);
    if (!deal) return;
    if (isTerminalState(deal.state)) return;
    const reason =
      typeof args['reason'] === 'string' ? (args['reason'] as string) : 'SWAP_FAILED';
    await this.failDeal(deal, reason);
  }

  private async onCancelled(args: Record<string, unknown>): Promise<void> {
    const deal = this.resolveDealFromArgs(args);
    if (!deal) return;
    if (isTerminalState(deal.state)) return;
    await this.failDeal(deal, 'CANCELLED');
  }

  // ---------------------------------------------------------------------------
  // Payout verification (spec 7.9.2)
  // ---------------------------------------------------------------------------

  /**
   * Poll `swap.getStatus(swapId)` until `payoutVerified === true` or retries
   * are exhausted. Returns `true` on success, `false` on exhaustion.
   */
  private async verifyPayout(deal: DealRecord, swapId: string): Promise<boolean> {
    const strategy = this.strategy();
    const interval = Math.max(0, strategy.payout_poll_interval_ms);
    const maxRetries = Math.max(0, strategy.payout_max_retries);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const status = await this.swap.getStatus(swapId);
        if (status.payoutVerified === true) {
          return true;
        }
      } catch (err) {
        process.stderr.write(
          `SwapExecutor: getStatus failed for ${deal.deal_id} (swap ${swapId}): ${(err as Error).message}\n`,
        );
      }

      if (attempt < maxRetries) {
        await this.sleep(interval);
        // If the deal was failed out from under us (e.g. timeout), stop.
        const current = this.store.getDeal(deal.deal_id);
        if (!current || isTerminalState(current.state)) {
          return false;
        }
      }
    }

    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---------------------------------------------------------------------------
  // EXECUTING-state watchdog
  // ---------------------------------------------------------------------------

  private setExecutingTimeout(deal: DealRecord): void {
    // Clear any existing timer first so a re-entry (e.g. recovery) does not
    // leak handles.
    const existing = this.executingTimers.get(deal.deal_id);
    if (existing) {
      clearTimeout(existing);
    }

    const ms = (deal.terms.deposit_timeout_sec + EXECUTING_TIMEOUT_GRACE_SEC) * 1000;
    const timer = setTimeout(() => {
      this.executingTimers.delete(deal.deal_id);
      const current = this.store.getDeal(deal.deal_id);
      if (current && current.state === 'EXECUTING') {
        void this.failDeal(current, 'EXECUTING_TIMEOUT');
      }
    }, ms);
    this.executingTimers.set(deal.deal_id, timer);
  }

  private clearExecutingTimer(dealId: string): void {
    const timer = this.executingTimers.get(dealId);
    if (timer) {
      clearTimeout(timer);
      this.executingTimers.delete(dealId);
    }
  }

  // ---------------------------------------------------------------------------
  // Terminal transitions
  // ---------------------------------------------------------------------------

  private async failDeal(deal: DealRecord, reason: string): Promise<void> {
    if (isTerminalState(deal.state)) return;
    deal.state = 'FAILED';
    deal.failure_reason = reason;
    deal.updated_at_ms = Date.now();
    this.store.setDeal(deal);
    this.clearExecutingTimer(deal.deal_id);
    this.ledger.release(deal.deal_id);
    await this.saveSafely();
    this.fireCompletion(deal);
  }

  private async completeDeal(deal: DealRecord, _volumeFilled: bigint): Promise<void> {
    if (isTerminalState(deal.state)) return;
    deal.state = 'COMPLETED';
    deal.payout_verified = true;
    deal.updated_at_ms = Date.now();
    this.store.setDeal(deal);
    this.clearExecutingTimer(deal.deal_id);
    this.ledger.release(deal.deal_id);
    await this.saveSafely();
    this.fireCompletion(deal);
  }

  private fireCompletion(deal: DealRecord): void {
    try {
      this.onSwapCompleted(deal);
    } catch (err) {
      process.stderr.write(
        `SwapExecutor: onSwapCompleted threw: ${(err as Error).message}\n`,
      );
    }
  }

  private async saveSafely(): Promise<void> {
    try {
      await this.store.save();
    } catch (err) {
      process.stderr.write(
        `SwapExecutor: store.save failed: ${(err as Error).message}\n`,
      );
    }
  }
}
