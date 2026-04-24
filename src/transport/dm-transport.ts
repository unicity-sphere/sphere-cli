/**
 * DmTransport — send HMCP-0 requests over Sphere DMs and await correlated responses.
 *
 * Usage:
 *   const transport = createDmTransport(sphere.communications, { managerAddress: '@mymanager' });
 *   const response  = await transport.sendRequest(createHmcpRequest('hm.list', {}));
 *   await transport.dispose();
 *
 * For commands that emit multiple responses (e.g. hm.spawn → ack + ready/failed):
 *   await transport.sendRequestStream(request, (response) => {
 *     process(response);
 *     return isTerminal(response.type); // return true to stop
 *   });
 */

import type { DirectMessage } from '@unicitylabs/sphere-sdk';
import type { HmcpRequest, HmcpResponse } from './hmcp-types.js';
import { parseHmcpResponse, byteLength, MAX_MESSAGE_SIZE } from './hmcp-types.js';
import { TimeoutError, TransportError } from './errors.js';

export type { HmcpRequest, HmcpResponse } from './hmcp-types.js';
export { createHmcpRequest, HMCP_RESPONSE_TYPES } from './hmcp-types.js';
export { TimeoutError, AuthError, TransportError } from './errors.js';

// =============================================================================
// Config / Interface
// =============================================================================

export interface DmTransportConfig {
  /**
   * Address of the host manager: @nametag, DIRECT://hex, or raw 64-char hex pubkey.
   * Sphere resolves nametags and DIRECT:// internally via sendDM.
   */
  managerAddress: string;

  /**
   * Default timeout for single-response requests (ms). Default: 30 000.
   */
  timeoutMs?: number;

  /**
   * Default timeout for streaming requests, e.g. spawn that waits for container
   * to become RUNNING. Default: 120 000.
   */
  streamTimeoutMs?: number;
}

/** Narrow slice of Sphere.communications needed by DmTransport — injectable for testing. */
export interface SphereComms {
  sendDM(recipient: string, content: string): Promise<{ recipientPubkey: string }>;
  onDirectMessage(handler: (message: DirectMessage) => void): () => void;
}

export interface DmTransport {
  /**
   * Send a request and return the first correlated response.
   * Throws TimeoutError if no response arrives within timeoutMs.
   * Throws TransportError if the send itself fails or the transport is disposed.
   */
  sendRequest(request: HmcpRequest, timeoutMs?: number): Promise<HmcpResponse>;

  /**
   * Send a request and receive all correlated responses until onResponse returns
   * true (done) or the stream timeout elapses.
   *
   * onResponse receives each HmcpResponse in order. Return true to signal done
   * (cleans up the correlator). Return false to keep listening.
   *
   * Throws TimeoutError or TransportError.
   */
  sendRequestStream(
    request: HmcpRequest,
    onResponse: (response: HmcpResponse) => boolean,
    timeoutMs?: number,
  ): Promise<void>;

  /** Release the DM subscription. Any in-flight requests reject with TransportError. */
  dispose(): Promise<void>;
}

// =============================================================================
// Pubkey normalisation
// =============================================================================

/** Strip 02/03 prefix to get x-only 64-char hex — matches CommunicationsModule._normalizeKey. */
function normalizeKey(key: string): string {
  if (key.length === 66 && (key.startsWith('02') || key.startsWith('03'))) {
    return key.slice(2);
  }
  return key;
}

// =============================================================================
// Implementation
// =============================================================================

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STREAM_TIMEOUT_MS = 120_000;

interface Correlator {
  handler: (response: HmcpResponse) => void;
  cancel: (err: Error) => void;
}

class DmTransportImpl implements DmTransport {
  private readonly timeoutMs: number;
  private readonly streamTimeoutMs: number;

  /**
   * Resolved x-only pubkey of the manager.
   * Set after the first successful sendDM call and cached for sender auth.
   * Concurrent first-sends write the same pubkey — safe.
   */
  private resolvedPubkey: string | null = null;

  /**
   * Messages that arrived before resolvedPubkey was set are buffered here and
   * replayed once the pubkey is known. Capped at 32 to bound memory if an
   * attacker floods DMs before the first send completes.
   */
  private readonly earlyMessages: DirectMessage[] = [];
  private static readonly EARLY_MESSAGE_CAP = 32;

  private readonly correlators = new Map<string, Correlator>();
  private readonly unsubscribeDMs: () => void;
  private disposed = false;

  constructor(
    private readonly comms: SphereComms,
    private readonly managerAddress: string,
    config: { timeoutMs: number; streamTimeoutMs: number },
  ) {
    this.timeoutMs = config.timeoutMs;
    this.streamTimeoutMs = config.streamTimeoutMs;

    // Subscribe once — route all incoming DMs through the correlator map.
    this.unsubscribeDMs = comms.onDirectMessage((msg) => this.handleIncoming(msg));
  }

  // ---------------------------------------------------------------------------

  private handleIncoming(msg: DirectMessage): void {
    // Race guard: a DM can arrive between `this.disposed = true` and
    // `this.unsubscribeDMs()` returning in dispose(). Short-circuit so a
    // late-arriving message cannot touch a disposed transport.
    if (this.disposed) return;

    // Early size cap — a malformed relay delivering a 10 MB DM never enters
    // the early-message buffer. parseHmcpResponse also enforces this on the
    // post-pubkey-resolution path, but catching it here saves memory when
    // the buffer is in use.
    if (byteLength(msg.content) > MAX_MESSAGE_SIZE) return;

    if (!this.resolvedPubkey) {
      // Buffer early messages so a fast manager reply isn't lost while sendDM
      // is still in-flight. Capped to avoid unbounded memory on DM floods.
      if (this.earlyMessages.length < DmTransportImpl.EARLY_MESSAGE_CAP) {
        this.earlyMessages.push(msg);
      } else if (process.env['DEBUG']) {
        // Cap hit: one DEBUG line per overflow so a legitimate chatty manager
        // during the handshake window is diagnosable. Silent drop otherwise.
        process.stderr.write(
          `dm-transport: early-message buffer full (cap=${DmTransportImpl.EARLY_MESSAGE_CAP}), dropping DM\n`,
        );
      }
      return;
    }
    if (normalizeKey(msg.senderPubkey) !== this.resolvedPubkey) return;

    const response = parseHmcpResponse(msg.content);
    if (!response) return;

    const correlator = this.correlators.get(response.in_reply_to);
    correlator?.handler(response);
  }

  // ---------------------------------------------------------------------------

  async sendRequest(request: HmcpRequest, timeoutMs?: number): Promise<HmcpResponse> {
    return new Promise<HmcpResponse>((resolve, reject) => {
      if (this.disposed) {
        reject(new TransportError('Transport has been disposed'));
        return;
      }

      const timeout = timeoutMs ?? this.timeoutMs;

      const cleanup = () => {
        clearTimeout(timer);
        this.correlators.delete(request.msg_id);
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new TimeoutError(`No response for ${request.type} within ${timeout} ms`));
      }, timeout);

      this.correlators.set(request.msg_id, {
        handler: (response) => { cleanup(); resolve(response); },
        cancel: (err)      => { cleanup(); reject(err); },
      });

      this.send(request).catch((err: unknown) => {
        cleanup();
        reject(new TransportError(`Failed to send ${request.type}: ${String((err as Error).message ?? err)}`));
      });
    });
  }

  // ---------------------------------------------------------------------------

  async sendRequestStream(
    request: HmcpRequest,
    onResponse: (response: HmcpResponse) => boolean,
    timeoutMs?: number,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.disposed) {
        reject(new TransportError('Transport has been disposed'));
        return;
      }

      const timeout = timeoutMs ?? this.streamTimeoutMs;

      const cleanup = () => {
        clearTimeout(timer);
        this.correlators.delete(request.msg_id);
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new TimeoutError(`Stream for ${request.type} timed out after ${timeout} ms`));
      }, timeout);

      this.correlators.set(request.msg_id, {
        handler: (response) => {
          let done: boolean;
          try {
            done = onResponse(response);
          } catch (err) {
            cleanup();
            reject(err);
            return;
          }
          if (done) { cleanup(); resolve(); }
          // else: keep correlator — more responses expected
        },
        cancel: (err) => { cleanup(); reject(err); },
      });

      this.send(request).catch((err: unknown) => {
        cleanup();
        reject(new TransportError(`Failed to send ${request.type}: ${String((err as Error).message ?? err)}`));
      });
    });
  }

  // ---------------------------------------------------------------------------

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeDMs();

    const err = new TransportError('Transport disposed');
    // Snapshot before iterating — cancel() calls cleanup() which deletes from
    // the map. Clearing the snapshot first avoids modifying during iteration.
    const pending = Array.from(this.correlators.values());
    this.correlators.clear();
    for (const { cancel } of pending) {
      cancel(err);
    }
  }

  // ---------------------------------------------------------------------------

  private async send(request: HmcpRequest): Promise<void> {
    // Send-side size cap — symmetric with the receive-side MAX_MESSAGE_SIZE
    // check in parseHmcpResponse. Prevents a local caller (e.g. `sphere host
    // cmd --params '<huge JSON>'`) from handing a 10 MB payload to the relay
    // and getting an opaque TransportError in response. Fail fast with a
    // clear size-limit message before hitting the transport.
    const serialized = JSON.stringify(request);
    if (byteLength(serialized) > MAX_MESSAGE_SIZE) {
      throw new TransportError(
        `Request too large: ${byteLength(serialized)} bytes exceeds MAX_MESSAGE_SIZE (${MAX_MESSAGE_SIZE})`,
      );
    }
    const sent = await this.comms.sendDM(this.managerAddress, serialized);
    // Cache the resolved pubkey on first send. Subsequent sends for the same
    // manager address produce the same pubkey, so concurrent writes are safe.
    if (!this.resolvedPubkey) {
      this.resolvedPubkey = normalizeKey(sent.recipientPubkey);
      // Replay any DMs that arrived before we knew the manager's pubkey.
      const pending = this.earlyMessages.splice(0);
      for (const msg of pending) {
        this.handleIncoming(msg);
      }
    }
  }
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a DmTransport connected to a specific manager address.
 *
 * Subscribes to incoming DMs immediately. The manager's pubkey is resolved
 * lazily on the first send — no network round-trip at construction.
 */
export function createDmTransport(comms: SphereComms, config: DmTransportConfig): DmTransport {
  return new DmTransportImpl(comms, config.managerAddress, {
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    streamTimeoutMs: config.streamTimeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS,
  });
}
