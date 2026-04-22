import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDmTransport } from './dm-transport.js';
import { createHmcpRequest, HMCP_VERSION } from './hmcp-types.js';
import { TimeoutError, TransportError } from './errors.js';
import type { DirectMessage } from '@unicitylabs/sphere-sdk';
import type { SphereComms } from './dm-transport.js';
import type { HmcpResponse } from './hmcp-types.js';

// Flush the microtask queue without touching the fake timer macrotask queue.
const flushPromises = () => new Promise<void>((resolve) => queueMicrotask(resolve));

// =============================================================================
// Helpers
// =============================================================================

const MANAGER_PUBKEY = 'a'.repeat(64); // 64-char x-only hex

function makeResponse(inReplyTo: string, type: HmcpResponse['type'], payload = {}): string {
  return JSON.stringify({ hmcp_version: HMCP_VERSION, in_reply_to: inReplyTo, type, payload });
}

function makeDM(content: string, senderPubkey = MANAGER_PUBKEY): DirectMessage {
  return {
    id: crypto.randomUUID(),
    senderPubkey,
    recipientPubkey: 'b'.repeat(64),
    content,
    timestamp: Date.now(),
    isRead: false,
  };
}

function buildMockComms() {
  const handlers: Array<(msg: DirectMessage) => void> = [];

  const comms: SphereComms = {
    sendDM: vi.fn().mockResolvedValue({ recipientPubkey: MANAGER_PUBKEY }),
    onDirectMessage: vi.fn((handler) => {
      handlers.push(handler);
      return () => { const idx = handlers.indexOf(handler); if (idx !== -1) handlers.splice(idx, 1); };
    }),
  };

  const deliver = (msg: DirectMessage) => handlers.forEach((h) => h(msg));

  return { comms, deliver };
}

// =============================================================================
// Tests
// =============================================================================

describe('DmTransport', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  // --------------------------------------------------------------------------
  // sendRequest — happy path
  // --------------------------------------------------------------------------

  it('sends request JSON and returns correlated response', async () => {
    const { comms, deliver } = buildMockComms();
    const transport = createDmTransport(comms, { managerAddress: '@manager', timeoutMs: 5_000 });

    const request = createHmcpRequest('hm.list', {});
    const responsePromise = transport.sendRequest(request);

    // Simulate network: after send resolves, manager replies
    await flushPromises();
    deliver(makeDM(makeResponse(request.msg_id, 'hm.list_result', { instances: [] })));

    const response = await responsePromise;
    expect(response.type).toBe('hm.list_result');
    expect(response.in_reply_to).toBe(request.msg_id);

    const sentBody = JSON.parse((comms.sendDM as ReturnType<typeof vi.fn>).mock.calls[0][1] as string);
    expect(sentBody.msg_id).toBe(request.msg_id);
    expect(sentBody.type).toBe('hm.list');

    await transport.dispose();
  });

  // --------------------------------------------------------------------------
  // sendRequest — timeout
  // --------------------------------------------------------------------------

  it('throws TimeoutError when no response arrives', async () => {
    const { comms } = buildMockComms();
    const transport = createDmTransport(comms, { managerAddress: '@manager', timeoutMs: 1_000 });

    const request = createHmcpRequest('hm.help', {});
    const responsePromise = transport.sendRequest(request);

    await flushPromises();
    vi.advanceTimersByTime(1_001);

    await expect(responsePromise).rejects.toThrow(TimeoutError);
    await transport.dispose();
  });

  // --------------------------------------------------------------------------
  // sendRequest — send failure
  // --------------------------------------------------------------------------

  it('throws TransportError when sendDM rejects', async () => {
    const { comms } = buildMockComms();
    (comms.sendDM as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('relay offline'));
    const transport = createDmTransport(comms, { managerAddress: '@manager', timeoutMs: 5_000 });

    const request = createHmcpRequest('hm.list', {});
    await expect(transport.sendRequest(request)).rejects.toThrow(TransportError);

    await transport.dispose();
  });

  // --------------------------------------------------------------------------
  // Auth: ignore DMs from unknown senders
  // --------------------------------------------------------------------------

  it('ignores DMs from senders other than the resolved manager', async () => {
    const { comms, deliver } = buildMockComms();
    const transport = createDmTransport(comms, { managerAddress: '@manager', timeoutMs: 200 });

    const request = createHmcpRequest('hm.list', {});
    const responsePromise = transport.sendRequest(request);
    await flushPromises();

    // Deliver from wrong sender — should be ignored
    deliver(makeDM(makeResponse(request.msg_id, 'hm.list_result', { instances: [] }), 'f'.repeat(64)));

    vi.advanceTimersByTime(201);
    await expect(responsePromise).rejects.toThrow(TimeoutError);

    await transport.dispose();
  });

  // --------------------------------------------------------------------------
  // Correlation: only routes to matching msg_id
  // --------------------------------------------------------------------------

  it('routes responses to correct correlator when multiple requests in-flight', async () => {
    const { comms, deliver } = buildMockComms();
    const transport = createDmTransport(comms, { managerAddress: '@manager', timeoutMs: 5_000 });

    const req1 = createHmcpRequest('hm.list', {});
    const req2 = createHmcpRequest('hm.help', {});

    const [p1, p2] = [transport.sendRequest(req1), transport.sendRequest(req2)];
    await flushPromises();

    deliver(makeDM(makeResponse(req2.msg_id, 'hm.help_result', { commands: [], version: '0.1' })));
    deliver(makeDM(makeResponse(req1.msg_id, 'hm.list_result', { instances: [] })));

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.type).toBe('hm.list_result');
    expect(r2.type).toBe('hm.help_result');

    await transport.dispose();
  });

  // --------------------------------------------------------------------------
  // sendRequestStream — multi-response (spawn flow)
  // --------------------------------------------------------------------------

  it('streams multiple responses until onResponse returns true', async () => {
    const { comms, deliver } = buildMockComms();
    const transport = createDmTransport(comms, { managerAddress: '@manager', streamTimeoutMs: 10_000 });

    const request = createHmcpRequest('hm.spawn', { template_id: 'tpl-1', instance_name: 'bot' });
    const received: string[] = [];

    const streamPromise = transport.sendRequestStream(request, (response) => {
      received.push(response.type);
      return response.type === 'hm.spawn_ready' || response.type === 'hm.spawn_failed';
    });

    await flushPromises();
    deliver(makeDM(makeResponse(request.msg_id, 'hm.spawn_ack', { accepted: true, instance_id: 'i1', instance_name: 'bot', state: 'BOOTING' })));
    await flushPromises();
    deliver(makeDM(makeResponse(request.msg_id, 'hm.spawn_ready', { instance_id: 'i1', instance_name: 'bot', state: 'RUNNING', tenant_pubkey: 'c'.repeat(64), tenant_direct_address: 'DIRECT://cccc', tenant_nametag: null })));

    await streamPromise;
    expect(received).toEqual(['hm.spawn_ack', 'hm.spawn_ready']);

    await transport.dispose();
  });

  // --------------------------------------------------------------------------
  // sendRequestStream — timeout
  // --------------------------------------------------------------------------

  it('throws TimeoutError when stream stalls before done', async () => {
    const { comms, deliver } = buildMockComms();
    const transport = createDmTransport(comms, { managerAddress: '@manager', streamTimeoutMs: 500 });

    const request = createHmcpRequest('hm.spawn', { template_id: 'tpl-1', instance_name: 'bot' });
    const received: string[] = [];

    const streamPromise = transport.sendRequestStream(request, (response) => {
      received.push(response.type);
      return response.type === 'hm.spawn_ready';
    });

    await flushPromises();
    // Only ack arrives — ready never comes
    deliver(makeDM(makeResponse(request.msg_id, 'hm.spawn_ack', { accepted: true, instance_id: 'i1', instance_name: 'bot', state: 'BOOTING' })));
    await flushPromises();

    vi.advanceTimersByTime(501);
    await expect(streamPromise).rejects.toThrow(TimeoutError);
    expect(received).toEqual(['hm.spawn_ack']);

    await transport.dispose();
  });

  // --------------------------------------------------------------------------
  // dispose rejects in-flight requests
  // --------------------------------------------------------------------------

  it('rejects in-flight requests when disposed', async () => {
    const { comms } = buildMockComms();
    // sendDM never resolves — simulates a stuck network
    (comms.sendDM as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    const transport = createDmTransport(comms, { managerAddress: '@manager', timeoutMs: 60_000 });

    const request = createHmcpRequest('hm.list', {});
    const responsePromise = transport.sendRequest(request);
    await flushPromises();

    await transport.dispose();
    await expect(responsePromise).rejects.toThrow(TransportError);
  });

  // --------------------------------------------------------------------------
  // Ignores malformed / oversized messages
  // --------------------------------------------------------------------------

  it('ignores malformed JSON from manager', async () => {
    const { comms, deliver } = buildMockComms();
    const transport = createDmTransport(comms, { managerAddress: '@manager', timeoutMs: 200 });

    const request = createHmcpRequest('hm.list', {});
    const responsePromise = transport.sendRequest(request);
    await flushPromises();

    deliver(makeDM('not json at all'));
    deliver(makeDM(JSON.stringify({ hmcp_version: HMCP_VERSION, in_reply_to: request.msg_id, type: 'UNKNOWN_TYPE', payload: {} })));

    vi.advanceTimersByTime(201);
    await expect(responsePromise).rejects.toThrow(TimeoutError);

    await transport.dispose();
  });

  it('ignores oversized messages', async () => {
    const { comms, deliver } = buildMockComms();
    const transport = createDmTransport(comms, { managerAddress: '@manager', timeoutMs: 200 });

    const request = createHmcpRequest('hm.list', {});
    const responsePromise = transport.sendRequest(request);
    await flushPromises();

    // 64 KiB + 1 byte
    deliver(makeDM('x'.repeat(64 * 1024 + 1)));

    vi.advanceTimersByTime(201);
    await expect(responsePromise).rejects.toThrow(TimeoutError);

    await transport.dispose();
  });

  // --------------------------------------------------------------------------
  // Dangerous keys rejected (prototype pollution)
  // --------------------------------------------------------------------------

  it('ignores messages containing dangerous keys', async () => {
    const { comms, deliver } = buildMockComms();
    const transport = createDmTransport(comms, { managerAddress: '@manager', timeoutMs: 200 });

    const request = createHmcpRequest('hm.list', {});
    const responsePromise = transport.sendRequest(request);
    await flushPromises();

    // Use a raw JSON string: `{ __proto__: ... }` in JS sets the prototype,
    // not an own key, so JSON.stringify would silently drop it.
    const poisoned = `{"hmcp_version":"${HMCP_VERSION}","in_reply_to":"${request.msg_id}","type":"hm.list_result","payload":{"__proto__":{"isAdmin":true}}}`;
    deliver(makeDM(poisoned));

    vi.advanceTimersByTime(201);
    await expect(responsePromise).rejects.toThrow(TimeoutError);

    await transport.dispose();
  });

  // --------------------------------------------------------------------------
  // Compressed pubkey normalisation
  // --------------------------------------------------------------------------

  it('matches manager pubkey when transport returns compressed 66-char form', async () => {
    const { comms, deliver } = buildMockComms();
    // sendDM returns a compressed (02-prefixed) pubkey
    const compressed = '02' + MANAGER_PUBKEY;
    (comms.sendDM as ReturnType<typeof vi.fn>).mockResolvedValue({ recipientPubkey: compressed });
    const transport = createDmTransport(comms, { managerAddress: '@manager', timeoutMs: 5_000 });

    const request = createHmcpRequest('hm.list', {});
    const responsePromise = transport.sendRequest(request);
    await flushPromises();

    // Reply comes with x-only pubkey — should still be recognised
    deliver(makeDM(makeResponse(request.msg_id, 'hm.list_result', { instances: [] }), MANAGER_PUBKEY));

    const response = await responsePromise;
    expect(response.type).toBe('hm.list_result');

    await transport.dispose();
  });

  // --------------------------------------------------------------------------
  // Already-disposed transport
  // --------------------------------------------------------------------------

  it('rejects immediately when transport is already disposed', async () => {
    const { comms } = buildMockComms();
    const transport = createDmTransport(comms, { managerAddress: '@manager' });
    await transport.dispose();

    const request = createHmcpRequest('hm.list', {});
    await expect(transport.sendRequest(request)).rejects.toThrow(TransportError);
    await expect(transport.sendRequestStream(request, () => true)).rejects.toThrow(TransportError);
  });
});
