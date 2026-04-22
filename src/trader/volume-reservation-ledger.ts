/**
 * VolumeReservationLedger — tracks reserved volume across in-flight deals so
 * the trader never over-commits its confirmed balance.
 *
 * Reservations are keyed by deal_id. When a deal enters PROPOSED state, volume
 * is reserved; when it completes, fails, or is cancelled, volume is released.
 *
 * The available volume for a new reservation is computed as:
 *
 *   available = payments.getConfirmedAmount(token) - totalReserved
 *
 * Because multiple concurrent matching operations could race on this check,
 * reserves are serialised behind a promise-chain mutex. The available amount
 * is re-computed *inside* the lock after awaiting any previous reserve.
 *
 * `release()` and `reconstruct()` are synchronous: no network I/O, no mutex.
 * They only mutate the in-memory map.
 *
 * This module intentionally has no Sphere SDK imports — it depends only on
 * the narrow {@link PaymentsAdapter} interface for dependency injection.
 */

import type { PaymentsAdapter } from './types.js';

export class VolumeReservationLedger {
  /** deal_id -> reserved volume (bigint, never number) */
  private readonly reservations = new Map<string, bigint>();

  /**
   * Promise-chain mutex. Each reserve() awaits the previous link and installs
   * its own release function as the next link, serialising all reserves.
   */
  private lock: Promise<void> = Promise.resolve();

  constructor(
    private readonly payments: PaymentsAdapter,
    private readonly token: string,
  ) {}

  /**
   * Attempt to reserve `volume` for `dealId`.
   *
   * Re-checks available balance *inside* the lock so concurrent reserves can't
   * both observe the same pre-reservation balance and collectively over-commit.
   *
   * @throws {Error} if the requested volume exceeds currently available balance.
   */
  async reserve(dealId: string, volume: bigint): Promise<void> {
    let releaseLock!: () => void;
    const nextLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const previousLock = this.lock;
    this.lock = nextLock;
    await previousLock;
    try {
      const confirmed = await this.payments.getConfirmedAmount(this.token);
      const available = confirmed - this.totalReserved;
      if (volume > available) {
        throw new Error(
          `Insufficient volume: need ${volume}, available ${available}`,
        );
      }
      this.reservations.set(dealId, volume);
    } finally {
      releaseLock();
    }
  }

  /**
   * Release the reservation for a deal. No-op if the deal has no reservation.
   *
   * Synchronous by design: deal-state transitions (COMPLETED / FAILED /
   * CANCELLED) already run serially per deal, and releases never need to
   * consult the payments adapter.
   */
  release(dealId: string): void {
    this.reservations.delete(dealId);
  }

  /**
   * Current total reserved volume summed across all deals.
   *
   * Computed on read rather than cached: the map is small (one entry per
   * in-flight deal) and cached totals would be a second source of truth to
   * keep in sync with the map.
   */
  get totalReserved(): bigint {
    let total = 0n;
    for (const volume of this.reservations.values()) {
      total += volume;
    }
    return total;
  }

  /**
   * Reconstruct a reservation from an existing deal record during startup
   * recovery. Only call with deals in PROPOSED, ACCEPTED, or EXECUTING state —
   * terminal states (COMPLETED / FAILED / CANCELLED) must not hold reservations.
   *
   * Synchronous: must be invoked before any async operation (including the
   * first `reserve()` call) so the ledger reflects real outstanding exposure
   * before any balance checks are performed.
   */
  reconstruct(dealId: string, volume: bigint): void {
    this.reservations.set(dealId, volume);
  }
}
