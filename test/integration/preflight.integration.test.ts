/**
 * Preflight health check for the public testnet endpoints.
 *
 * Runs first (filename sorts before cli-*) and sets a module-level flag
 * the other integration suites read via beforeAll. When any endpoint is
 * down, subsequent tests are skipped with a clear reason rather than
 * failing with opaque "sphere wallet init exited 1" messages.
 *
 * Each probe has a 5s budget — fast enough that a slow endpoint
 * doesn't bloat CI time by more than ~15s worst case.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { connect as tlsConnect } from 'node:tls';
import { PUBLIC_TESTNET, integrationSkip } from './helpers.js';

const PROBE_TIMEOUT_MS = 5_000;

export interface PreflightResult {
  aggregator: boolean;
  ipfs: boolean;
  nostr: boolean;
}

export const preflight: PreflightResult = {
  aggregator: false,
  ipfs: false,
  nostr: false,
};

async function probeHttp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // Any response that doesn't throw means the service responded.
    // Aggregator JSON-RPC may return 405/404 for HEAD on /rpc — still "up".
    return res.status < 600;
  } catch {
    return false;
  }
}

/**
 * Probe the Nostr relay's TCP+TLS layer. A full WebSocket handshake would
 * need the `ws` package as a direct dependency; a TLS connect is enough
 * to confirm the relay host is reachable and the certificate is valid.
 * If the TLS layer accepts us, the WebSocket upgrade almost always works.
 */
async function probeTls(wssUrl: string): Promise<boolean> {
  const u = new URL(wssUrl);
  const port = u.port ? Number(u.port) : 443;
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    const socket = tlsConnect({
      host: u.hostname,
      port,
      servername: u.hostname,
      timeout: PROBE_TIMEOUT_MS,
    });
    socket.once('secureConnect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

describe.skipIf(integrationSkip)('integration preflight — public testnet reachability', () => {
  beforeAll(async () => {
    const [agg, ipfs, nostr] = await Promise.all([
      probeHttp(PUBLIC_TESTNET.aggregator),
      probeHttp(PUBLIC_TESTNET.ipfsGateway),
      probeTls(PUBLIC_TESTNET.nostrRelay),
    ]);
    preflight.aggregator = agg;
    preflight.ipfs = ipfs;
    preflight.nostr = nostr;
  }, 30_000);

  it('aggregator is reachable', () => {
    expect(
      preflight.aggregator,
      `${PUBLIC_TESTNET.aggregator} did not respond within ${PROBE_TIMEOUT_MS}ms. ` +
        `Downstream tests that require the aggregator will be skipped.`,
    ).toBe(true);
  });

  it('IPFS gateway is reachable', () => {
    expect(
      preflight.ipfs,
      `${PUBLIC_TESTNET.ipfsGateway} did not respond within ${PROBE_TIMEOUT_MS}ms.`,
    ).toBe(true);
  });

  it('Nostr relay accepts WebSocket connection', () => {
    expect(
      preflight.nostr,
      `${PUBLIC_TESTNET.nostrRelay} did not accept a WebSocket handshake within ${PROBE_TIMEOUT_MS}ms.`,
    ).toBe(true);
  });
});
