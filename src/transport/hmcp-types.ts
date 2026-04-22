/**
 * HMCP-0 (Host Manager Control Protocol) types, constructors, and validators.
 * Mirrors the protocol definition in agentic-hosting — kept in sync by hand.
 */

export const HMCP_VERSION = '0.1';

export const HMCP_REQUEST_TYPES = [
  'hm.spawn',
  'hm.list',
  'hm.stop',
  'hm.start',
  'hm.inspect',
  'hm.help',
  'hm.command',
  'hm.remove',
  'hm.pause',
  'hm.resume',
] as const;
export type HmcpRequestType = (typeof HMCP_REQUEST_TYPES)[number];

export const HMCP_RESPONSE_TYPES = [
  'hm.spawn_ack',
  'hm.spawn_ready',
  'hm.spawn_failed',
  'hm.list_result',
  'hm.stop_result',
  'hm.start_ack',
  'hm.start_ready',
  'hm.start_failed',
  'hm.inspect_result',
  'hm.help_result',
  'hm.error',
  'hm.command_result',
  'hm.remove_result',
  'hm.pause_result',
  'hm.resume_result',
  'hm.resume_ready',
  'hm.resume_failed',
] as const;
export type HmcpResponseType = (typeof HMCP_RESPONSE_TYPES)[number];

// ---- Core message types ----

export interface HmcpRequest {
  readonly hmcp_version: string;
  readonly msg_id: string;
  readonly ts_ms: number;
  readonly type: HmcpRequestType;
  readonly payload: Record<string, unknown>;
}

export interface HmcpResponse {
  readonly hmcp_version: string;
  readonly in_reply_to: string;
  readonly type: HmcpResponseType;
  readonly payload: Record<string, unknown>;
}

// ---- Spawn ----

export interface HmSpawnPayload {
  readonly template_id: string;
  readonly instance_name: string;
  readonly nametag?: string | null;
  readonly env?: Readonly<Record<string, string>>;
}

export interface HmSpawnAckPayload {
  readonly accepted: boolean;
  readonly instance_id: string;
  readonly instance_name: string;
  readonly state: string;
}

export interface HmSpawnReadyPayload {
  readonly instance_id: string;
  readonly instance_name: string;
  readonly state: 'RUNNING';
  readonly tenant_pubkey: string;
  readonly tenant_direct_address: string;
  readonly tenant_nametag: string | null;
}

export interface HmSpawnFailedPayload {
  readonly instance_id: string;
  readonly instance_name: string;
  readonly state: 'FAILED';
  readonly reason: string;
}

// ---- List ----

export interface HmInstanceSummary {
  readonly instance_id: string;
  readonly instance_name: string;
  readonly template_id: string;
  readonly state: string;
  readonly tenant_pubkey: string | null;
  readonly created_at: string;
}

export interface HmListResultPayload {
  readonly instances: readonly HmInstanceSummary[];
}

// ---- Stop / Start ----

export interface HmStopResultPayload {
  readonly instance_id: string;
  readonly instance_name: string;
  readonly state: 'STOPPED';
}

export interface HmStartAckPayload {
  readonly accepted: boolean;
  readonly instance_id: string;
  readonly instance_name: string;
  readonly state: string;
}

export interface HmStartReadyPayload {
  readonly instance_id: string;
  readonly instance_name: string;
  readonly state: 'RUNNING';
  readonly tenant_pubkey: string;
  readonly tenant_direct_address: string;
  readonly tenant_nametag: string | null;
}

export interface HmStartFailedPayload {
  readonly instance_id: string;
  readonly instance_name: string;
  readonly state: 'FAILED';
  readonly reason: string;
}

// ---- Inspect ----

export interface HmInspectResultPayload {
  readonly instance_id: string;
  readonly instance_name: string;
  readonly template_id: string;
  readonly state: string;
  readonly created_at: string;
  readonly tenant_pubkey: string | null;
  readonly tenant_direct_address: string | null;
  readonly tenant_nametag: string | null;
  readonly last_heartbeat_at: string | null;
  readonly docker_container_id: string | null;
}

// ---- Help ----

export interface HmHelpResultPayload {
  readonly commands: readonly string[];
  readonly version: string;
}

// ---- Command ----

export interface HmCommandPayload {
  readonly instance_id?: string;
  readonly instance_name?: string;
  readonly command: string;
  readonly params?: Record<string, unknown>;
  readonly timeout_ms?: number;
}

export interface HmCommandResultPayload {
  readonly instance_id: string;
  readonly instance_name: string;
  readonly command: string;
  readonly result: Record<string, unknown>;
}

// ---- Error ----

export interface HmErrorPayload {
  readonly error_code: string;
  readonly message: string;
}

// ---- Constructors ----

export function createHmcpRequest(type: HmcpRequestType, payload: Record<string, unknown>): HmcpRequest {
  return {
    hmcp_version: HMCP_VERSION,
    msg_id: crypto.randomUUID(),
    ts_ms: Date.now(),
    type,
    payload,
  };
}

// ---- Validators ----

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function hasDangerousKeys(value: unknown, depth = 0): boolean {
  if (depth > 20 || typeof value !== 'object' || value === null) return false;
  for (const key of Object.keys(value as object)) {
    if (DANGEROUS_KEYS.has(key)) return true;
    if (hasDangerousKeys((value as Record<string, unknown>)[key], depth + 1)) return true;
  }
  return false;
}

export const MAX_MESSAGE_SIZE = 64 * 1024; // 64 KiB

export function isValidHmcpResponse(msg: unknown): msg is HmcpResponse {
  if (typeof msg !== 'object' || msg === null) return false;
  const obj = msg as Record<string, unknown>;
  return (
    obj['hmcp_version'] === HMCP_VERSION &&
    typeof obj['in_reply_to'] === 'string' && obj['in_reply_to'] !== '' &&
    typeof obj['type'] === 'string' &&
    (HMCP_RESPONSE_TYPES as readonly string[]).includes(obj['type'] as string) &&
    typeof obj['payload'] === 'object' &&
    obj['payload'] !== null &&
    !hasDangerousKeys(obj)
  );
}

export function parseHmcpResponse(data: string): HmcpResponse | null {
  if (data.length > MAX_MESSAGE_SIZE) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  return isValidHmcpResponse(parsed) ? parsed : null;
}
