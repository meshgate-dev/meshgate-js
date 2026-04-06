/**
 * Tests for _pendingVerify disambiguation (MG23-004 / RID-015 to RID-019).
 *
 * Verifies that the SDK correctly distinguishes between:
 * - token_exhausted_on_retry: this SDK instance had an in-flight verify-token
 *   call when the 403 arrived (server burned the token but network dropped the
 *   200 response; this call is the retry)
 * - token_already_used: no prior in-flight call from this instance — another
 *   process likely consumed the token
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoopAdapter } from './adapters/noop-adapter.js';
import { MeshgateClient } from './client.js';
import { MeshgateOrphanedError } from './errors.js';
import type { GateOrphanedEvent } from './types.js';

const API_KEY = 'mg_test_tok_exhaust';
const LOCAL_SECRET = 'b'.repeat(32);

function makeClient(
  onGateOrphaned?: (event: GateOrphanedEvent) => void,
): MeshgateClient {
  return new MeshgateClient({
    apiKey: API_KEY,
    localEncryptionKey: LOCAL_SECRET,
    storageAdapter: new NoopAdapter(),
    hooks: { onGateOrphaned },
  });
}

function makeJsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeGatedRes(approvalId: string): Response {
  return makeJsonRes(201, {
    outcome: 'gated',
    approvalId,
    intent: 'test_intent',
    expiresAt: '2099-01-01T00:00:00Z',
  });
}

function makeSseApprovalStream(approvalId: string, token: string): Response {
  const encoder = new TextEncoder();
  const data = JSON.stringify({ entityId: approvalId, payload: { token } });
  const chunk = encoder.encode(`event: approval.approved\ndata: ${data}\n\n`);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('_pendingVerify — token_exhausted_on_retry vs token_already_used', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fires onGateOrphaned with reason=token_already_used on first-call 403 token_exhausted', async () => {
    const approvalId = 'appr_already_used';
    const orphanedEvents: GateOrphanedEvent[] = [];
    const client = makeClient((e) => orphanedEvents.push(e));
    const wrapped = client.guard(() => Promise.resolve('ok'), { intent: 'tx_already_used' });

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeGatedRes(approvalId))
      .mockResolvedValueOnce(makeSseApprovalStream(approvalId, 'tok_stale'))
      // verify-token returns 403 — no prior in-flight from this instance
      .mockResolvedValueOnce(makeJsonRes(403, { error: 'token_exhausted' }));

    await expect(wrapped()).rejects.toBeInstanceOf(MeshgateOrphanedError);

    expect(orphanedEvents).toHaveLength(1);
    expect(orphanedEvents[0]?.reason).toBe('token_already_used');
    expect(orphanedEvents[0]?.approvalId).toBe(approvalId);
    expect(orphanedEvents[0]?.intent).toBe('tx_already_used');
  });

  it('fires onGateOrphaned with reason=gate_not_found on 404', async () => {
    const approvalId = 'appr_404';
    const orphanedEvents: GateOrphanedEvent[] = [];
    const client = makeClient((e) => orphanedEvents.push(e));
    const wrapped = client.guard(() => Promise.resolve('ok'), { intent: 'tx_not_found' });

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeGatedRes(approvalId))
      .mockResolvedValueOnce(makeSseApprovalStream(approvalId, 'tok_404'))
      .mockResolvedValueOnce(makeJsonRes(404, { error: 'not_found' }));

    await expect(wrapped()).rejects.toBeInstanceOf(MeshgateOrphanedError);

    expect(orphanedEvents).toHaveLength(1);
    expect(orphanedEvents[0]?.reason).toBe('gate_not_found');
  });

  it('GateOrphanedEvent includes intent, approvalId, expiresAt, reason, message', async () => {
    const approvalId = 'appr_fields_check';
    const orphanedEvents: GateOrphanedEvent[] = [];
    const client = makeClient((e) => orphanedEvents.push(e));
    const wrapped = client.guard(() => Promise.resolve('ok'), { intent: 'tx_fields' });

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeGatedRes(approvalId))
      .mockResolvedValueOnce(makeSseApprovalStream(approvalId, 'tok_x'))
      .mockResolvedValueOnce(makeJsonRes(403, { error: 'token_exhausted' }));

    await expect(wrapped()).rejects.toBeInstanceOf(MeshgateOrphanedError);

    const event = orphanedEvents[0];
    expect(event.approvalId).toBe(approvalId);
    expect(event.intent).toBe('tx_fields');
    expect(event.expiresAt).toBe('2099-01-01T00:00:00Z');
    expect(typeof event.reason).toBe('string');
    expect(typeof event.message).toBe('string');
  });

  it('does not fire onGateOrphaned for network errors (non-403/non-404)', async () => {
    const approvalId = 'appr_network_err';
    const orphanedEvents: GateOrphanedEvent[] = [];
    const client = makeClient((e) => orphanedEvents.push(e));
    const wrapped = client.guard(() => Promise.resolve('ok'), { intent: 'tx_net_err' });

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeGatedRes(approvalId))
      .mockResolvedValueOnce(makeSseApprovalStream(approvalId, 'tok_net'))
      // Simulate network error on verify-token (after retries in api client)
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(wrapped()).rejects.toThrow();
    // onGateOrphaned should NOT fire for network errors — only for 403/404
    expect(orphanedEvents).toHaveLength(0);
  });
});
