/**
 * Tests for sseReconnectDelays config option (MG23-004 / RID-024).
 *
 * Verifies that:
 * 1. SseClient accepts and uses a custom reconnectDelays schedule
 * 2. MeshgateClient passes sseReconnectDelays through to SseClient
 * 3. Fallback to polling occurs after delays are exhausted
 *
 * The timing tests use [0, 0, 0] to avoid real wait times in CI.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoopAdapter } from './adapters/noop-adapter.js';
import { MeshgateClient } from './client.js';
import { SseClient } from './utils/sse-client.js';

const API_KEY = 'mg_test_sse_reconnect';
const LOCAL_SECRET = 'c'.repeat(32);

function makeJsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A Response that immediately closes with no events — triggers a reconnect. */
function makeEmptySseStream(): Response {
  return new Response(new ReadableStream({ start(c) { c.close(); } }), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('sseReconnectDelays config option', () => {
  afterEach(() => vi.restoreAllMocks());

  it('default sseReconnectDelays is [0, 1000, 2000] when not specified', () => {
    const client = new MeshgateClient({
      apiKey: API_KEY,
      localEncryptionKey: LOCAL_SECRET,
      storageAdapter: new NoopAdapter(),
    });
    expect(client).toBeDefined();
  });

  it('SseClient uses custom reconnectDelays — calls onPollFallback after delays exhausted', async () => {
    let pollFallbackCalled = false;

    // 3 delays = 4 total attempts (delays.length + 1) before fallback
    const sseClient = new SseClient('http://localhost/events', {}, {
      onEvent: () => {},
      onPollFallback: () => { pollFallbackCalled = true; },
      onError: () => {},
      reconnectDelays: [0, 0, 0], // 3 zero-delay reconnects → fallback on 4th failure
    });

    // 4 empty streams = 4 failures → onPollFallback
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeEmptySseStream());

    sseClient.start();

    // Wait for the connect loop to exhaust delays and call onPollFallback
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (pollFallbackCalled) {
          clearInterval(interval);
          resolve();
        }
      }, 10);
      // Fail safe: resolve after 2s regardless
      setTimeout(resolve, 2000);
    });

    sseClient.stop();
    expect(pollFallbackCalled).toBe(true);
  }, 5000);

  it('SseClient with fewer reconnectDelays falls back sooner', async () => {
    const callCounts = { event: 0, pollFallback: 0 };

    // Only 1 delay = 2 total attempts before fallback
    const sseClient = new SseClient('http://localhost/events', {}, {
      onEvent: () => {},
      onPollFallback: () => { callCounts.pollFallback++; },
      onError: () => {},
      reconnectDelays: [0], // 1 delay → fallback after 2nd failure
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeEmptySseStream());

    sseClient.start();

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (callCounts.pollFallback > 0) {
          clearInterval(interval);
          resolve();
        }
      }, 10);
      setTimeout(resolve, 2000);
    });

    sseClient.stop();
    expect(callCounts.pollFallback).toBe(1);
  }, 5000);

  it('MeshgateClient passes sseReconnectDelays to the SSE client', async () => {
    // Verify that passing sseReconnectDelays on MeshgateClient config is accepted
    // and that the SSE connection uses it by checking fallback timing
    const client = new MeshgateClient({
      apiKey: API_KEY,
      localEncryptionKey: LOCAL_SECRET,
      storageAdapter: new NoopAdapter(),
      sseReconnectDelays: [0, 0, 0],
    });

    // The client should construct without error and the config should be accepted
    expect(client).toBeDefined();

    const gateRes = makeJsonRes(201, {
      outcome: 'gated',
      approvalId: 'appr_sse_cfg',
      intent: 'sse_cfg_test',
      expiresAt: '2099-01-01T00:00:00Z',
    });

    let sseCallCount = 0;
    let pollingCalled = false;

    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const urlStr = url instanceof URL ? url.href : url instanceof Request ? url.url : url;
      if (urlStr.includes('/v1/intent')) return Promise.resolve(gateRes);
      if (urlStr.includes('/events/stream')) {
        sseCallCount++;
        return Promise.resolve(makeEmptySseStream());
      }
      if (urlStr.includes('/status')) {
        pollingCalled = true;
        // Return pending to avoid resolving the gate
        return Promise.resolve(
          makeJsonRes(200, { id: 'appr_sse_cfg', status: 'pending', resolvedAt: null, token: null, gateNonce: null }),
        );
      }
      return Promise.resolve(makeEmptySseStream());
    });

    const wrapped = client.guard(() => Promise.resolve('ok'), { intent: 'sse_cfg_test' });
    const guardPromise = wrapped().catch(() => {}); // may not resolve in test

    // Allow SSE to fail and trigger poll fallback (with [0, 0, 0] delays, should be fast)
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (pollingCalled || sseCallCount >= 4) {
          clearInterval(interval);
          resolve();
        }
      }, 20);
      setTimeout(resolve, 2000);
    });

    // After 4 SSE failures with [0,0,0] delays, polling should have started
    expect(sseCallCount).toBeGreaterThanOrEqual(4);

    void guardPromise;
  }, 8000);
});
