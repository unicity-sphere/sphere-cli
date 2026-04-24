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

/**
 * Use a JSON.parse reviver to detect dangerous keys at parse time, regardless
 * of nesting depth. This avoids the depth-20 cliff of a recursive walk and
 * runs in O(n) with a single parse pass. If a dangerous key is found the
 * entire message is rejected (not silently cleaned) — we set `value` to null
 * so downstream mishandling cannot accidentally use a half-stripped object.
 */
function safeParse(data: string): { value: unknown; hadDangerousKeys: boolean } {
  let hadDangerousKeys = false;
  const value = JSON.parse(data, (key, val) => {
    if (DANGEROUS_KEYS.has(key)) { hadDangerousKeys = true; return undefined; }
    return val;
  });
  // Reject-not-sanitize: if any dangerous key was seen, null the output so a
  // caller that forgets to check `hadDangerousKeys` cannot accidentally use
  // a partially-scrubbed object. parseHmcpResponse also short-circuits on
  // the flag, but defense-in-depth costs nothing.
  return hadDangerousKeys ? { value: null, hadDangerousKeys } : { value, hadDangerousKeys };
}

/**
 * Structural check used by host-commands.ts to validate --params arguments.
 *
 * Iterative, bounded walk — originally recursive which was vulnerable to a
 * stack-overflow self-DoS on pathological 10k-deep JSON from `--params`. The
 * CLI parses --params with regular JSON.parse (not our safeParse reviver) so
 * this guard IS the primary defense for the local command-line path.
 */
const MAX_PARAMS_DEPTH = 64;

export function hasDangerousKeys(value: unknown): boolean {
  // Explicit stack instead of recursion: `{ value, depth }` frames. The depth
  // cap guards against deeply-nested attacker input; 64 is comfortably deeper
  // than any realistic hand-written --params payload while bounded enough to
  // prevent a stack-allocation DoS via the interpreter itself.
  const stack: Array<{ v: unknown; d: number }> = [{ v: value, d: 0 }];
  while (stack.length > 0) {
    const { v, d } = stack.pop()!;
    if (d > MAX_PARAMS_DEPTH) return true;  // too deep to inspect — conservative reject
    if (typeof v !== 'object' || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) stack.push({ v: item, d: d + 1 });
      continue;
    }
    const obj = v as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (DANGEROUS_KEYS.has(key)) return true;
      stack.push({ v: obj[key], d: d + 1 });
    }
  }
  return false;
}

// 64 KiB measured in UTF-8 bytes, not JS string code units (which are UTF-16).
export const MAX_MESSAGE_SIZE = 64 * 1024;

export function byteLength(s: string): number {
  // Buffer.byteLength is available in Node; fall back to approximate for other runtimes.
  if (typeof Buffer !== 'undefined') return Buffer.byteLength(s, 'utf8');
  return new TextEncoder().encode(s).length;
}

export function isValidHmcpResponse(msg: unknown): msg is HmcpResponse {
  if (typeof msg !== 'object' || msg === null) return false;
  const obj = msg as Record<string, unknown>;
  return (
    obj['hmcp_version'] === HMCP_VERSION &&
    typeof obj['in_reply_to'] === 'string' && obj['in_reply_to'] !== '' &&
    typeof obj['type'] === 'string' &&
    (HMCP_RESPONSE_TYPES as readonly string[]).includes(obj['type'] as string) &&
    typeof obj['payload'] === 'object' &&
    obj['payload'] !== null
  );
}

export function parseHmcpResponse(data: string): HmcpResponse | null {
  if (byteLength(data) > MAX_MESSAGE_SIZE) return null;
  let result: { value: unknown; hadDangerousKeys: boolean };
  try {
    result = safeParse(data);
  } catch {
    return null;
  }
  if (result.hadDangerousKeys) return null;
  return isValidHmcpResponse(result.value) ? result.value : null;
}
