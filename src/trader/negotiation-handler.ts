/**
 * NegotiationHandler — drives the NP-0 negotiation protocol.
 *
 * Responsibilities:
 *   - React to IntentEngine match events (propose if we're the proposer,
 *     wait for an incoming proposal otherwise).
 *   - Serialise, sign, and send `np.propose`, `np.accept`, `np.reject`,
 *     `np.cancel` messages via the injected CommsAdapter.
 *   - Validate and authenticate every incoming NP-0 message (spec 7.6).
 *   - Enforce DoS protections: size cap, prototype-pollution guard,
 *     rate limit per counterparty, msg_id dedup window.
 *   - Enforce proposal/acceptance timeouts and the duplicate-deal guard
 *     (spec 5.7).
 *   - Hand off ACCEPTED deals to the caller via `onDealAccepted`.
 *
 * Design notes:
 *   - Signature verification is pluggable via `CryptoAdapter` so unit tests
 *     can inject a fake without pulling in a real secp256k1 implementation.
 *   - All error paths log to stderr and return cleanly: a malformed DM from
 *     an adversary must never crash the long-running trader process.
 *   - Timers are stored in instance fields so `stop()` can tear them down
 *     deterministically and avoid leaking handles in tests.
 */

import type {
  CommsAdapter,
  DealRecord,
  DealTerms,
  IncomingDM,
  IntentRecord,
  NpMessage,
  NpMessageType,
  OnDealAccepted,
  TraderStrategy,
} from './types.js';
import type { TraderStateStore } from './trader-state-store.js';
import type { MatchEvent } from './intent-engine.js';

import { canonicalJson, hasDangerousKeys, validateDealTerms } from './utils.js';

// =============================================================================
// Constants
// =============================================================================

/** Rate denominator for the ×1e8 rate encoding (offer * rate / 1e8 = request). */
const RATE_DENOMINATOR = 100_000_000n;

/** Maximum clock skew for incoming NP-0 messages (spec 7.6). */
const MAX_TIMESTAMP_SKEW_MS = 300_000;

/** Replay-protection window for dedup of msg_ids (spec 7.6). */
const MSG_ID_DEDUP_WINDOW_MS = 600_000;

/** Maximum number of entries retained in the dedup map (DoS bound). */
const MSG_ID_DEDUP_MAX_ENTRIES = 10_000;

/** Maximum NP-0 message size in bytes (DoS bound). */
const MAX_MESSAGE_BYTES = 64 * 1024;

/** Rate limit: max proposals accepted from one counterparty in the window. */
const RATE_LIMIT_MAX_PROPOSALS = 3;

/** Rate limit window. */
const RATE_LIMIT_WINDOW_MS = 60_000;

/** Default proposal timeout if strategy does not specify one. */
const DEFAULT_PROPOSAL_TIMEOUT_MS = 30_000;

/** Default acceptance timeout if strategy does not specify one. */
const DEFAULT_ACCEPTANCE_TIMEOUT_MS = 60_000;

/** Debug logging opt-in. */
const DEBUG = typeof process !== 'undefined' && Boolean(process.env['DEBUG']);

// =============================================================================
// CryptoAdapter — pluggable secp256k1 signer/verifier
// =============================================================================

/**
 * Narrow injection seam for signing/verifying NP-0 messages. Implementations
 * wrap whatever secp256k1 backend the runtime provides (e.g. the Sphere SDK).
 * Tests inject a deterministic fake.
 */
export interface CryptoAdapter {
  /** Produce a hex signature over `data`. */
  sign(data: string): Promise<string>;
  /** Verify a hex signature against `pubkey` (x-only, 64-char hex). */
  verify(data: string, signature: string, pubkey: string): Promise<boolean>;
  /** Return this adapter's x-only public key (64-char hex). */
  getPublicKey(): string;
}

// =============================================================================
// Helpers
// =============================================================================

/** Canonical JSON payload over which the signature is computed. */
function messageToSign(msg: Omit<NpMessage, 'signature'>): string {
  return canonicalJson(msg as unknown as Record<string, unknown>);
}

/** UTF-8 byte length of a string. */
function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** Deterministic deal id: `deal_<proposerIntent>_<acceptorIntent>` so a
 *  reconnecting agent cannot accidentally double-register the same deal. */
function buildDealId(proposerIntentId: string, acceptorIntentId: string): string {
  return `deal_${proposerIntentId}_${acceptorIntentId}`;
}

/** Random msg_id (16 bytes of entropy rendered as hex). */
function newMsgId(): string {
  const buf = new Uint8Array(16);
  for (let i = 0; i < buf.length; i++) {
    buf[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Simple bigint midpoint (floor of the arithmetic mean). */
function midpoint(a: bigint, b: bigint): bigint {
  return (a + b) / 2n;
}

/** Resolve a `DIRECT://<hex>` or raw-hex pubkey to a Sphere address string. */
function pubkeyToAddress(pubkey: string): string {
  if (pubkey.startsWith('DIRECT://') || pubkey.startsWith('@')) return pubkey;
  return `DIRECT://${pubkey}`;
}

/** Terminal deal states: no further state transitions allowed. */
function isTerminalState(state: DealRecord['state']): boolean {
  return state === 'COMPLETED' || state === 'FAILED' || state === 'CANCELLED';
}

// =============================================================================
// NegotiationHandler
// =============================================================================

export class NegotiationHandler {
  private started = false;
  private dmUnsubscribe: (() => void) | null = null;

  /** dealId -> timeout handle (proposal or acceptance watchdog). */
  private readonly pendingProposals = new Map<string, ReturnType<typeof setTimeout>>();
  /** dealId -> sent msg_id (match incoming np.accept via in_reply_to). */
  private readonly proposalMsgIds = new Map<string, string>();
  /** msg_id -> ts_ms (replay/dedup window). */
  private readonly seenMsgIds = new Map<string, number>();
  /** sender_pubkey -> array of proposal receive timestamps (rate-limit). */
  private readonly proposalRateLimit = new Map<string, number[]>();

  constructor(
    private readonly store: TraderStateStore,
    private readonly comms: CommsAdapter,
    private readonly crypto: CryptoAdapter,
    private readonly strategy: () => TraderStrategy,
    private readonly onDealAccepted: OnDealAccepted,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  start(): void {
    if (this.started) return;
    this.started = true;
    this.dmUnsubscribe = this.comms.onDirectMessage((msg) => {
      void this.handleIncomingDM(msg).catch((err) => {
        process.stderr.write(
          `NegotiationHandler: uncaught error in handleIncomingDM: ${(err as Error).message}\n`,
        );
      });
    });
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.dmUnsubscribe) {
      try {
        this.dmUnsubscribe();
      } catch {
        // ignore — we're tearing down
      }
      this.dmUnsubscribe = null;
    }
    for (const timer of this.pendingProposals.values()) {
      clearTimeout(timer);
    }
    this.pendingProposals.clear();
  }

  // ---------------------------------------------------------------------------
  // Read-only accessors
  // ---------------------------------------------------------------------------

  getDeal(dealId: string): DealRecord | undefined {
    return this.store.getDeal(dealId);
  }

  getAllDeals(): DealRecord[] {
    return this.store.getAllDeals();
  }

  // ---------------------------------------------------------------------------
  // Proposal flow (we are PROPOSER)
  // ---------------------------------------------------------------------------

  async onMatchFound(event: MatchEvent): Promise<void> {
    if (!event.shouldPropose) {
      // Acceptor side: nothing to do proactively — we wait for np.propose.
      return;
    }

    try {
      const strategy = this.strategy();
      const terms = this.buildTerms(event, strategy);
      if (!terms) return;

      // Duplicate-deal guard (spec 5.7): skip if a non-terminal deal already
      // exists for this counterparty intent id.
      const acceptorIntentId = terms.acceptor_intent_id;
      const existing = this.store
        .getDealsByIntentId(acceptorIntentId)
        .find((d) => !isTerminalState(d.state));
      if (existing) {
        if (DEBUG) {
          process.stderr.write(
            `NegotiationHandler: skipping propose — existing deal ${existing.deal_id} in state ${existing.state}\n`,
          );
        }
        return;
      }

      try {
        validateDealTerms(terms);
      } catch (err) {
        process.stderr.write(
          `NegotiationHandler: buildTerms produced invalid terms: ${(err as Error).message}\n`,
        );
        return;
      }

      const now = Date.now();
      const dealId = buildDealId(terms.proposer_intent_id, terms.acceptor_intent_id);
      const deal: DealRecord = {
        deal_id: dealId,
        terms,
        state: 'PROPOSED',
        role: 'PROPOSER',
        created_at_ms: now,
        updated_at_ms: now,
        failure_reason: null,
        deposit_attempted: false,
        payout_verified: false,
      };
      this.store.setDeal(deal);

      const msg = await this.buildSignedMessage('np.propose', {
        deal_id: dealId,
        terms: this.serializeTerms(terms),
      });
      this.proposalMsgIds.set(dealId, msg.msg_id);

      const address = pubkeyToAddress(event.listing.poster_pubkey);
      try {
        await this.comms.sendDM(address, JSON.stringify(msg));
      } catch (err) {
        process.stderr.write(
          `NegotiationHandler: sendDM failed for np.propose ${dealId}: ${(err as Error).message}\n`,
        );
        this.cancelDeal(dealId, 'send_failed');
        this.proposalMsgIds.delete(dealId);
        await this.saveSafely();
        return;
      }

      // Proposal watchdog: if we never get np.accept, cancel the deal.
      const timeoutMs = strategy.proposal_timeout_ms || DEFAULT_PROPOSAL_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pendingProposals.delete(dealId);
        this.cancelDeal(dealId, 'proposal_timeout');
        void this.saveSafely();
      }, timeoutMs);
      this.pendingProposals.set(dealId, timer);

      await this.saveSafely();
    } catch (err) {
      process.stderr.write(
        `NegotiationHandler: onMatchFound error: ${(err as Error).message}\n`,
      );
    }
  }

  private buildTerms(event: MatchEvent, strategy: TraderStrategy): DealTerms | null {
    const { intent: myRecord, listing, decoded } = event;
    const myIntent = myRecord.intent;

    const myRemaining = myIntent.offer_volume_max - myRecord.volume_filled;
    if (myRemaining <= 0n) return null;

    const offerVolume = myRemaining < decoded.offer_volume_max ? myRemaining : decoded.offer_volume_max;
    if (offerVolume <= 0n) return null;

    const rate = midpoint(myIntent.rate_min, decoded.rate_min);
    if (rate <= 0n) return null;

    const requestVolume = (offerVolume * rate) / RATE_DENOMINATOR;
    if (requestVolume <= 0n) return null;

    const trusted = new Set(strategy.trusted_escrows);
    const escrow = decoded.escrows.find((e) => trusted.has(e));
    if (!escrow) return null;

    // Acceptor intent_id: embedded in the market listing id (spec 2.8 pairs
    // listing_id to intent_id). Fall back to listing_id for resilience.
    const acceptorIntentId = listing.listing_id;

    return {
      proposer_intent_id: myIntent.intent_id,
      acceptor_intent_id: acceptorIntentId,
      proposer_pubkey: this.crypto.getPublicKey(),
      acceptor_pubkey: listing.poster_pubkey,
      offer_token: myIntent.offer_token,
      request_token: myIntent.request_token,
      offer_volume: offerVolume,
      request_volume: requestVolume,
      rate,
      escrow_address: escrow,
      deposit_timeout_sec: decoded.deposit_timeout_sec,
    };
  }

  // ---------------------------------------------------------------------------
  // Incoming DM routing
  // ---------------------------------------------------------------------------

  private async handleIncomingDM(dm: IncomingDM): Promise<void> {
    const raw = dm.content;
    if (typeof raw !== 'string' || raw.length === 0) return;
    if (byteLength(raw) > MAX_MESSAGE_BYTES) {
      if (DEBUG) {
        process.stderr.write('NegotiationHandler: dropping oversize DM\n');
      }
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Not one of ours — ignore silently (trader shares the inbox with other
      // protocols).
      return;
    }

    if (!this.isNpMessageShape(parsed)) return;
    const msg = parsed;

    // Auth (spec 7.6)
    if (!(await this.validateAuth(msg, dm.senderPubkey))) return;

    try {
      switch (msg.type) {
        case 'np.propose':
          await this.handleProposal(msg, dm.senderPubkey);
          break;
        case 'np.accept':
          await this.handleAcceptance(msg);
          break;
        case 'np.reject':
          await this.handleRejection(msg);
          break;
        case 'np.cancel':
          await this.handleCancel(msg);
          break;
        default:
          // Unknown type — ignore.
          break;
      }
    } catch (err) {
      process.stderr.write(
        `NegotiationHandler: error handling ${msg.type}: ${(err as Error).message}\n`,
      );
    }
  }

  private isNpMessageShape(value: unknown): value is NpMessage {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    if (v['np_version'] !== '0.1') return false;
    if (typeof v['msg_id'] !== 'string' || (v['msg_id'] as string).length === 0) return false;
    if (typeof v['ts_ms'] !== 'number' || !Number.isFinite(v['ts_ms'])) return false;
    if (typeof v['sender_pubkey'] !== 'string') return false;
    if (typeof v['signature'] !== 'string') return false;
    if (typeof v['type'] !== 'string') return false;
    const t = v['type'] as string;
    if (t !== 'np.propose' && t !== 'np.accept' && t !== 'np.reject' && t !== 'np.cancel') {
      return false;
    }
    if (!v['payload'] || typeof v['payload'] !== 'object') return false;
    return true;
  }

  private async validateAuth(msg: NpMessage, senderPubkey: string): Promise<boolean> {
    if (msg.np_version !== '0.1') return false;

    const now = Date.now();
    if (Math.abs(now - msg.ts_ms) > MAX_TIMESTAMP_SKEW_MS) {
      if (DEBUG) {
        process.stderr.write(`NegotiationHandler: rejecting stale msg ${msg.msg_id}\n`);
      }
      return false;
    }

    if (msg.sender_pubkey !== senderPubkey) {
      if (DEBUG) {
        process.stderr.write('NegotiationHandler: sender_pubkey mismatch\n');
      }
      return false;
    }

    if (hasDangerousKeys(msg)) {
      process.stderr.write('NegotiationHandler: dangerous keys in NP-0 message\n');
      return false;
    }

    // Dedup window — reject if we've already seen this msg_id recently.
    this.pruneSeenMsgIds(now);
    if (this.seenMsgIds.has(msg.msg_id)) {
      if (DEBUG) {
        process.stderr.write(`NegotiationHandler: replay of ${msg.msg_id}\n`);
      }
      return false;
    }

    // Signature verification
    const { signature: _sig, ...unsigned } = msg;
    let valid = false;
    try {
      valid = await this.crypto.verify(messageToSign(unsigned), msg.signature, msg.sender_pubkey);
    } catch (err) {
      process.stderr.write(
        `NegotiationHandler: verify threw: ${(err as Error).message}\n`,
      );
      return false;
    }
    if (!valid) {
      if (DEBUG) {
        process.stderr.write(`NegotiationHandler: bad signature on ${msg.msg_id}\n`);
      }
      return false;
    }

    // Accept and record.
    this.seenMsgIds.set(msg.msg_id, now);
    this.capSeenMsgIds();
    return true;
  }

  private pruneSeenMsgIds(now: number): void {
    const cutoff = now - MSG_ID_DEDUP_WINDOW_MS;
    for (const [id, ts] of this.seenMsgIds) {
      if (ts < cutoff) this.seenMsgIds.delete(id);
    }
  }

  private capSeenMsgIds(): void {
    if (this.seenMsgIds.size <= MSG_ID_DEDUP_MAX_ENTRIES) return;
    // Evict oldest entries (insertion order in a Map is insertion order).
    const overflow = this.seenMsgIds.size - MSG_ID_DEDUP_MAX_ENTRIES;
    let i = 0;
    for (const key of this.seenMsgIds.keys()) {
      if (i++ >= overflow) break;
      this.seenMsgIds.delete(key);
    }
  }

  // ---------------------------------------------------------------------------
  // Acceptance flow (we are ACCEPTOR)
  // ---------------------------------------------------------------------------

  private async handleProposal(msg: NpMessage, senderPubkey: string): Promise<void> {
    // Rate limit per counterparty.
    if (!this.checkRateLimit(senderPubkey)) {
      if (DEBUG) {
        process.stderr.write(`NegotiationHandler: rate-limited ${senderPubkey}\n`);
      }
      return;
    }

    const strategy = this.strategy();
    if (strategy.blocked_counterparties.includes(senderPubkey)) {
      if (DEBUG) {
        process.stderr.write(`NegotiationHandler: blocked counterparty ${senderPubkey}\n`);
      }
      return;
    }

    const termsRaw = (msg.payload as Record<string, unknown>)['terms'];
    const terms = this.deserializeTerms(termsRaw);
    if (!terms) {
      process.stderr.write('NegotiationHandler: invalid terms in np.propose\n');
      return;
    }

    try {
      validateDealTerms(terms);
    } catch (err) {
      process.stderr.write(
        `NegotiationHandler: rejecting np.propose — ${(err as Error).message}\n`,
      );
      return;
    }

    // Cross-check the proposer pubkey in the terms matches the envelope.
    if (terms.proposer_pubkey !== senderPubkey) {
      process.stderr.write('NegotiationHandler: proposer_pubkey mismatch in np.propose\n');
      return;
    }
    if (terms.acceptor_pubkey !== this.crypto.getPublicKey()) {
      if (DEBUG) {
        process.stderr.write('NegotiationHandler: acceptor_pubkey not us — ignoring\n');
      }
      return;
    }

    // Find our matching ACTIVE intent.
    const myIntent = this.findMatchingIntent(terms);
    if (!myIntent) {
      if (DEBUG) {
        process.stderr.write('NegotiationHandler: no matching local intent for np.propose\n');
      }
      return;
    }

    // Verify the acceptor_intent_id in the terms refers to our intent.
    if (terms.acceptor_intent_id !== myIntent.intent.intent_id) {
      if (DEBUG) {
        process.stderr.write('NegotiationHandler: acceptor_intent_id mismatch\n');
      }
      return;
    }

    // Duplicate-deal guard — non-terminal deal already exists.
    const existing = this.store
      .getDealsByIntentId(myIntent.intent.intent_id)
      .find((d) => !isTerminalState(d.state));
    if (existing) {
      if (DEBUG) {
        process.stderr.write(
          `NegotiationHandler: duplicate proposal — existing deal ${existing.deal_id}\n`,
        );
      }
      return;
    }

    const now = Date.now();
    const dealId = buildDealId(terms.proposer_intent_id, terms.acceptor_intent_id);
    const deal: DealRecord = {
      deal_id: dealId,
      terms,
      state: 'ACCEPTED',
      role: 'ACCEPTOR',
      created_at_ms: now,
      updated_at_ms: now,
      failure_reason: null,
      deposit_attempted: false,
      payout_verified: false,
    };
    this.store.setDeal(deal);

    // Build and send np.accept.
    const accept = await this.buildSignedMessage(
      'np.accept',
      { deal_id: dealId, in_reply_to: msg.msg_id },
    );
    const address = pubkeyToAddress(senderPubkey);
    try {
      await this.comms.sendDM(address, JSON.stringify(accept));
    } catch (err) {
      process.stderr.write(
        `NegotiationHandler: sendDM failed for np.accept ${dealId}: ${(err as Error).message}\n`,
      );
      this.cancelDeal(dealId, 'send_failed');
      await this.saveSafely();
      return;
    }

    // Acceptance watchdog — if deal stays in ACCEPTED (never reaches EXECUTING)
    // within the window, mark it CANCELLED.
    const timeoutMs = strategy.acceptance_timeout_ms || DEFAULT_ACCEPTANCE_TIMEOUT_MS;
    const timer = setTimeout(() => {
      this.pendingProposals.delete(dealId);
      const current = this.store.getDeal(dealId);
      if (current && current.state === 'ACCEPTED') {
        this.cancelDeal(dealId, 'acceptance_timeout');
        void this.saveSafely();
      }
    }, timeoutMs);
    this.pendingProposals.set(dealId, timer);

    try {
      this.onDealAccepted(deal);
    } catch (err) {
      process.stderr.write(
        `NegotiationHandler: onDealAccepted threw: ${(err as Error).message}\n`,
      );
    }

    await this.saveSafely();
  }

  private checkRateLimit(pubkey: string): boolean {
    const now = Date.now();
    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    const existing = this.proposalRateLimit.get(pubkey) ?? [];
    const recent = existing.filter((ts) => ts >= cutoff);
    if (recent.length >= RATE_LIMIT_MAX_PROPOSALS) {
      this.proposalRateLimit.set(pubkey, recent);
      return false;
    }
    recent.push(now);
    this.proposalRateLimit.set(pubkey, recent);
    return true;
  }

  private findMatchingIntent(terms: DealTerms): IntentRecord | null {
    for (const record of this.store.getIntentsByState('ACTIVE')) {
      const i = record.intent;
      if (i.offer_token !== terms.request_token) continue;
      if (i.request_token !== terms.offer_token) continue;
      // Volume: the proposer's request_volume is our offer; must fall inside
      // our own offer range.
      const remaining = i.offer_volume_max - record.volume_filled;
      if (terms.request_volume > remaining) continue;
      if (terms.request_volume < i.offer_volume_min) continue;
      // Rate: proposer's rate must fall inside our own rate band.
      if (terms.rate < i.rate_min) continue;
      if (terms.rate > i.rate_max) continue;
      return record;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Accept / Reject / Cancel inbound handlers
  // ---------------------------------------------------------------------------

  private async handleAcceptance(msg: NpMessage): Promise<void> {
    const payload = msg.payload as Record<string, unknown>;
    const inReplyTo = payload['in_reply_to'];
    if (typeof inReplyTo !== 'string' || inReplyTo.length === 0) return;

    // Locate the deal whose outgoing msg_id matches.
    let dealId: string | null = null;
    for (const [id, sentId] of this.proposalMsgIds) {
      if (sentId === inReplyTo) {
        dealId = id;
        break;
      }
    }
    if (!dealId) {
      if (DEBUG) {
        process.stderr.write(
          `NegotiationHandler: np.accept references unknown msg ${inReplyTo}\n`,
        );
      }
      return;
    }

    const deal = this.store.getDeal(dealId);
    if (!deal) return;
    if (deal.role !== 'PROPOSER') return;
    if (deal.state !== 'PROPOSED') return;
    // Sanity: acceptance must come from the expected acceptor.
    if (deal.terms.acceptor_pubkey !== msg.sender_pubkey) {
      process.stderr.write('NegotiationHandler: np.accept from wrong sender\n');
      return;
    }

    const next: DealRecord = {
      ...deal,
      state: 'ACCEPTED',
      updated_at_ms: Date.now(),
    };
    this.store.setDeal(next);

    const timer = this.pendingProposals.get(dealId);
    if (timer) {
      clearTimeout(timer);
      this.pendingProposals.delete(dealId);
    }
    this.proposalMsgIds.delete(dealId);

    try {
      this.onDealAccepted(next);
    } catch (err) {
      process.stderr.write(
        `NegotiationHandler: onDealAccepted threw: ${(err as Error).message}\n`,
      );
    }

    await this.saveSafely();
  }

  private async handleRejection(msg: NpMessage): Promise<void> {
    const payload = msg.payload as Record<string, unknown>;
    const dealId = this.resolveDealIdForInbound(payload, msg.sender_pubkey);
    if (!dealId) return;
    this.cancelDeal(dealId, 'rejected_by_counterparty');
    await this.saveSafely();
  }

  private async handleCancel(msg: NpMessage): Promise<void> {
    const payload = msg.payload as Record<string, unknown>;
    const dealId = this.resolveDealIdForInbound(payload, msg.sender_pubkey);
    if (!dealId) return;
    const deal = this.store.getDeal(dealId);
    if (!deal) return;
    if (deal.state !== 'PROPOSED' && deal.state !== 'ACCEPTED') return;
    this.cancelDeal(dealId, 'cancelled_by_counterparty');
    await this.saveSafely();
  }

  /** Look up a deal for an inbound reject/cancel. Checks `deal_id` first, then
   *  falls back to `in_reply_to` matched against our sent proposal ids. */
  private resolveDealIdForInbound(
    payload: Record<string, unknown>,
    senderPubkey: string,
  ): string | null {
    const declared = payload['deal_id'];
    if (typeof declared === 'string' && declared.length > 0) {
      const deal = this.store.getDeal(declared);
      if (!deal) return null;
      if (
        deal.terms.proposer_pubkey !== senderPubkey &&
        deal.terms.acceptor_pubkey !== senderPubkey
      ) {
        return null;
      }
      return declared;
    }
    const inReplyTo = payload['in_reply_to'];
    if (typeof inReplyTo === 'string') {
      for (const [id, sentId] of this.proposalMsgIds) {
        if (sentId === inReplyTo) return id;
      }
    }
    return null;
  }

  private cancelDeal(dealId: string, reason: string): void {
    const deal = this.store.getDeal(dealId);
    if (!deal) return;
    if (isTerminalState(deal.state)) return;
    const next: DealRecord = {
      ...deal,
      state: 'CANCELLED',
      updated_at_ms: Date.now(),
      failure_reason: reason,
    };
    this.store.setDeal(next);

    const timer = this.pendingProposals.get(dealId);
    if (timer) {
      clearTimeout(timer);
      this.pendingProposals.delete(dealId);
    }
    this.proposalMsgIds.delete(dealId);
  }

  // ---------------------------------------------------------------------------
  // Message construction / serialisation
  // ---------------------------------------------------------------------------

  private async buildSignedMessage(
    type: NpMessageType,
    payload: Record<string, unknown>,
  ): Promise<NpMessage> {
    const unsigned: Omit<NpMessage, 'signature'> = {
      np_version: '0.1',
      msg_id: newMsgId(),
      ts_ms: Date.now(),
      sender_pubkey: this.crypto.getPublicKey(),
      type,
      payload,
    };
    const signature = await this.crypto.sign(messageToSign(unsigned));
    return { ...unsigned, signature };
  }

  /** JSON-safe encoding of DealTerms — bigints serialised as decimal strings. */
  private serializeTerms(terms: DealTerms): Record<string, unknown> {
    return {
      proposer_intent_id: terms.proposer_intent_id,
      acceptor_intent_id: terms.acceptor_intent_id,
      proposer_pubkey: terms.proposer_pubkey,
      acceptor_pubkey: terms.acceptor_pubkey,
      offer_token: terms.offer_token,
      request_token: terms.request_token,
      offer_volume: terms.offer_volume.toString(),
      request_volume: terms.request_volume.toString(),
      rate: terms.rate.toString(),
      escrow_address: terms.escrow_address,
      deposit_timeout_sec: terms.deposit_timeout_sec,
    };
  }

  private deserializeTerms(raw: unknown): DealTerms | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    try {
      const offer = this.asBigInt(r['offer_volume']);
      const request = this.asBigInt(r['request_volume']);
      const rate = this.asBigInt(r['rate']);
      if (offer === null || request === null || rate === null) return null;

      const proposer_intent_id = this.asString(r['proposer_intent_id']);
      const acceptor_intent_id = this.asString(r['acceptor_intent_id']);
      const proposer_pubkey = this.asString(r['proposer_pubkey']);
      const acceptor_pubkey = this.asString(r['acceptor_pubkey']);
      const offer_token = this.asString(r['offer_token']);
      const request_token = this.asString(r['request_token']);
      const escrow_address = this.asString(r['escrow_address']);
      const deposit_timeout_sec = r['deposit_timeout_sec'];

      if (
        proposer_intent_id === null ||
        acceptor_intent_id === null ||
        proposer_pubkey === null ||
        acceptor_pubkey === null ||
        offer_token === null ||
        request_token === null ||
        escrow_address === null ||
        typeof deposit_timeout_sec !== 'number' ||
        !Number.isFinite(deposit_timeout_sec)
      ) {
        return null;
      }

      return {
        proposer_intent_id,
        acceptor_intent_id,
        proposer_pubkey,
        acceptor_pubkey,
        offer_token,
        request_token,
        offer_volume: offer,
        request_volume: request,
        rate,
        escrow_address,
        deposit_timeout_sec,
      };
    } catch {
      return null;
    }
  }

  private asBigInt(v: unknown): bigint | null {
    try {
      if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
      if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
      return null;
    } catch {
      return null;
    }
  }

  private asString(v: unknown): string | null {
    return typeof v === 'string' && v.length > 0 ? v : null;
  }

  private async saveSafely(): Promise<void> {
    try {
      await this.store.save();
    } catch (err) {
      process.stderr.write(
        `NegotiationHandler: store.save failed: ${(err as Error).message}\n`,
      );
    }
  }
}
