/**
 * ACP-0 envelope helpers — JSON parse + size cap + dangerous-keys + freshness.
 *
 * Mirror of trader-service/src/protocols/envelope.ts (itself mirroring
 * agentic-hosting/src/protocols/envelope.ts post-decoupling). Trimmed to the
 * surface this CLI's DM transport actually needs.
 */

import { isValidAcpMessage } from './acp-protocols.js';
import type { AcpMessage } from './acp-protocols.js';

/** 64 KiB ceiling on serialized ACP payloads (UTF-16 code-unit count). */
export const MAX_MESSAGE_SIZE = 64 * 1024;
export const MAX_NESTING_DEPTH = 20;

/**
 * ±5min clock-skew tolerance applied at every inbound parse site. Beyond
 * the structural validity check, this catches stale replays whose msg_id /
 * content hash slipped past dedup (e.g. after TTL expiry, restart of the
 * receiver, or cross-instance log loss). Symmetric — receivers rejecting
 * only "future" leak clock-skew info to the sender.
 */
export const MAX_CLOCK_SKEW_MS = 300_000;

export function hasDangerousKeys(obj: unknown, depth = 0): boolean {
  if (depth > MAX_NESTING_DEPTH) return true;
  if (typeof obj !== 'object' || obj === null) return false;
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return true;
    }
    const val = (obj as Record<string, unknown>)[key];
    if (typeof val === 'object' && val !== null && hasDangerousKeys(val, depth + 1)) {
      return true;
    }
  }
  return false;
}

export function isTimestampFresh(tsMs: number, now: number = Date.now()): boolean {
  if (typeof tsMs !== 'number' || !Number.isFinite(tsMs)) return false;
  return Math.abs(tsMs - now) <= MAX_CLOCK_SKEW_MS;
}

export function parseAcpJson(data: string): AcpMessage | null {
  if (data.length > MAX_MESSAGE_SIZE) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (hasDangerousKeys(parsed)) return null;
  if (!isValidAcpMessage(parsed)) return null;
  return parsed;
}
