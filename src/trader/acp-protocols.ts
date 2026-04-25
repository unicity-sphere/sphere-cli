/**
 * ACP-0 (Agent Control Protocol) types, constructors, and validators.
 *
 * Mirror of trader-service/src/protocols/acp.ts (which itself mirrors
 * agentic-hosting/src/protocols/acp.ts after the Phase 4(h) decoupling).
 * ACP-0 is owned by the agentic-hosting protocol spec; if the spec evolves,
 * all three repos must update in lockstep.
 *
 * Why duplicated rather than imported: this CLI ships standalone (no
 * runtime dep on trader-service); the transport boundary is the same
 * 6-message ACP envelope set so the duplication is small + bounded.
 */

import { randomUUID } from 'node:crypto';
import { hasDangerousKeys } from './acp-envelope.js';

export const ACP_VERSION = '0.1';

export const ACP_MESSAGE_TYPES = [
  'acp.hello',
  'acp.hello_ack',
  'acp.heartbeat',
  'acp.ping',
  'acp.pong',
  'acp.command',
  'acp.result',
  'acp.error',
] as const;
export type AcpMessageType = (typeof ACP_MESSAGE_TYPES)[number];

export interface AcpCommandPayload {
  readonly command_id: string;
  readonly name: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface AcpResultPayload {
  readonly command_id: string;
  readonly ok: true;
  readonly result: Readonly<Record<string, unknown>>;
}

export interface AcpErrorPayload {
  readonly command_id: string;
  readonly ok: false;
  readonly error_code: string;
  readonly message: string;
}

export interface AcpMessage {
  readonly acp_version: string;
  readonly msg_id: string;
  readonly ts_ms: number;
  readonly instance_id: string;
  readonly instance_name: string;
  readonly type: AcpMessageType;
  readonly payload: Record<string, unknown>;
}

export function createAcpMessage(
  type: AcpMessageType,
  instanceId: string,
  instanceName: string,
  payload: Record<string, unknown>,
): AcpMessage {
  return {
    acp_version: ACP_VERSION,
    msg_id: randomUUID(),
    ts_ms: Date.now(),
    instance_id: instanceId,
    instance_name: instanceName,
    type,
    payload,
  };
}

export function isValidAcpMessage(msg: unknown): msg is AcpMessage {
  if (typeof msg !== 'object' || msg === null) return false;
  const obj = msg as Record<string, unknown>;
  return (
    obj['acp_version'] === ACP_VERSION &&
    typeof obj['msg_id'] === 'string' && obj['msg_id'] !== '' &&
    Number.isFinite(obj['ts_ms']) &&
    typeof obj['instance_id'] === 'string' && obj['instance_id'] !== '' &&
    typeof obj['instance_name'] === 'string' && obj['instance_name'] !== '' &&
    typeof obj['type'] === 'string' &&
    (ACP_MESSAGE_TYPES as readonly string[]).includes(obj['type'] as string) &&
    typeof obj['payload'] === 'object' &&
    obj['payload'] !== null &&
    !hasDangerousKeys(obj)
  );
}

export function isAcpResultPayload(payload: unknown): payload is AcpResultPayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p['command_id'] === 'string' && p['command_id'] !== '' &&
    p['ok'] === true &&
    typeof p['result'] === 'object' && p['result'] !== null && !Array.isArray(p['result'])
  );
}

export function isAcpErrorPayload(payload: unknown): payload is AcpErrorPayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p['command_id'] === 'string' &&
    p['ok'] === false &&
    typeof p['error_code'] === 'string' && p['error_code'] !== '' &&
    typeof p['message'] === 'string'
  );
}
