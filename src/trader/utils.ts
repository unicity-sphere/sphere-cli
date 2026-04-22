/**
 * Trader utilities: intent/deal validation, canonical JSON serialisation,
 * market description encoder/decoder, and dangerous-key detection for NP-0.
 */

import type { TradingIntent, DealTerms } from './types.js';
import type { CreateIntentParams } from './acp-types.js';

const MAX_EXPIRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// =============================================================================
// Validation
// =============================================================================

export function validateIntent(params: CreateIntentParams): void {
  const { offer_token, request_token, offer_volume_min, offer_volume_max, rate_min, rate_max, expiry_ms, deposit_timeout_sec } = params;

  if (typeof offer_token !== 'string' || offer_token.length === 0) {
    throw new Error('offer_token must be a non-empty string');
  }
  if (typeof request_token !== 'string' || request_token.length === 0) {
    throw new Error('request_token must be a non-empty string');
  }

  for (const [name, v] of [
    ['offer_volume_min', offer_volume_min],
    ['offer_volume_max', offer_volume_max],
    ['rate_min', rate_min],
    ['rate_max', rate_max],
  ] as const) {
    if (typeof v !== 'number' || !Number.isFinite(v) || Number.isNaN(v)) {
      throw new Error(`${name} must be a finite number`);
    }
    if (v < 0) {
      throw new Error(`${name} must not be negative`);
    }
  }

  if (offer_volume_min <= 0) {
    throw new Error('offer_volume_min must be > 0');
  }
  if (offer_volume_max < offer_volume_min) {
    throw new Error('offer_volume_max must be >= offer_volume_min');
  }
  if (rate_min <= 0) {
    throw new Error('rate_min must be > 0');
  }
  if (rate_max < rate_min) {
    throw new Error('rate_max must be >= rate_min');
  }

  if (typeof expiry_ms !== 'number' || !Number.isFinite(expiry_ms)) {
    throw new Error('expiry_ms must be a finite number');
  }
  const now = Date.now();
  if (expiry_ms <= now) {
    throw new Error('expiry_ms must be in the future');
  }
  if (expiry_ms > now + MAX_EXPIRY_WINDOW_MS) {
    throw new Error('expiry_ms must be within 7 days from now');
  }

  if (deposit_timeout_sec !== undefined) {
    if (typeof deposit_timeout_sec !== 'number' || !Number.isFinite(deposit_timeout_sec) || deposit_timeout_sec <= 0) {
      throw new Error('deposit_timeout_sec must be > 0');
    }
  }
}

export function validateDealTerms(terms: DealTerms): void {
  if (terms.offer_volume <= 0n) {
    throw new Error('offer_volume must be > 0');
  }
  if (terms.request_volume <= 0n) {
    throw new Error('request_volume must be > 0');
  }
  if (terms.rate <= 0n) {
    throw new Error('rate must be > 0');
  }
  if (terms.proposer_pubkey === terms.acceptor_pubkey) {
    throw new Error('proposer and acceptor pubkeys must differ');
  }
  if (typeof terms.escrow_address !== 'string' || terms.escrow_address.length === 0) {
    throw new Error('escrow_address must be a non-empty string');
  }
  if (terms.deposit_timeout_sec <= 0) {
    throw new Error('deposit_timeout_sec must be > 0');
  }
}

// =============================================================================
// Canonical JSON (deterministic, keys sorted)
// =============================================================================

export function canonicalJson(obj: Record<string, unknown>): string {
  return JSON.stringify(sortKeys(obj));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      out[k] = sortKeys(src[k]);
    }
    return out;
  }
  return value;
}

// =============================================================================
// Market description encoder/decoder (spec 2.8, 4-line format)
// =============================================================================

export interface DecodedDescription {
  readonly offer_token: string;
  readonly offer_volume_min: bigint;
  readonly offer_volume_max: bigint;
  readonly rate_min: bigint;
  readonly rate_max: bigint;
  readonly request_token: string;
  readonly expiry_ms: number;
  readonly escrows: readonly string[];
  readonly salt: string;
  readonly deposit_timeout_sec: number;
}

export function encodeDescription(intent: TradingIntent, escrows: readonly string[]): string {
  const line1 = `TRADE offer=${intent.offer_token} vol=${intent.offer_volume_min}-${intent.offer_volume_max} rate=${intent.rate_min}-${intent.rate_max}`;
  const line2 = `req=${intent.request_token} expires=${new Date(intent.expiry_ms).toISOString()}`;
  const line3 = `escrows=${escrows.join(',')}`;
  const line4 = `salt=${intent.salt} timeout=${intent.deposit_timeout_sec}`;
  return `${line1}\n${line2}\n${line3}\n${line4}`;
}

export function decodeDescription(description: string): DecodedDescription | null {
  if (typeof description !== 'string') return null;
  const lines = description.split('\n');
  if (lines.length < 4) return null;

  const line1 = lines[0] ?? '';
  const line2 = lines[1] ?? '';
  const line3 = lines[2] ?? '';
  const line4 = lines[3] ?? '';

  // Line 1: "TRADE offer=<token> vol=<min>-<max> rate=<min>-<max>"
  const m1 = /^TRADE offer=(\S+) vol=(\d+)-(\d+) rate=(\d+)-(\d+)$/.exec(line1);
  if (!m1) return null;
  const offer_token = m1[1]!;
  const offer_volume_min = safeBigInt(m1[2]!);
  const offer_volume_max = safeBigInt(m1[3]!);
  const rate_min = safeBigInt(m1[4]!);
  const rate_max = safeBigInt(m1[5]!);
  if (offer_volume_min === null || offer_volume_max === null || rate_min === null || rate_max === null) return null;

  // Line 2: "req=<token> expires=<iso8601>"
  const m2 = /^req=(\S+) expires=(\S+)$/.exec(line2);
  if (!m2) return null;
  const request_token = m2[1]!;
  const expiryDate = new Date(m2[2]!);
  const expiry_ms = expiryDate.getTime();
  if (!Number.isFinite(expiry_ms)) return null;

  // Line 3: "escrows=<comma-separated>"
  const m3 = /^escrows=(.*)$/.exec(line3);
  if (!m3) return null;
  const rawEscrows = m3[1] ?? '';
  const escrows = rawEscrows.length === 0 ? [] : rawEscrows.split(',');

  // Line 4: "salt=<hex> timeout=<sec>"
  const m4 = /^salt=(\S+) timeout=(\d+)$/.exec(line4);
  if (!m4) return null;
  const salt = m4[1]!;
  const deposit_timeout_sec = Number(m4[2]);
  if (!Number.isFinite(deposit_timeout_sec)) return null;

  return {
    offer_token,
    offer_volume_min,
    offer_volume_max,
    rate_min,
    rate_max,
    request_token,
    expiry_ms,
    escrows,
    salt,
    deposit_timeout_sec,
  };
}

function safeBigInt(s: string): bigint | null {
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}

// =============================================================================
// Dangerous-key detection for NP-0 messages
// =============================================================================

export function hasDangerousKeys(value: unknown, depth: number = 0): boolean {
  if (depth > 20) return true;
  if (typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (hasDangerousKeys(item, depth + 1)) return true;
    }
    return false;
  }
  for (const key of Object.keys(value as object)) {
    if (DANGEROUS_KEYS.has(key)) return true;
    if (hasDangerousKeys((value as Record<string, unknown>)[key], depth + 1)) return true;
  }
  return false;
}
