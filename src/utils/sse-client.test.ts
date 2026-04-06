import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SseEvent } from '../api/types.js';
import { SseClient } from './sse-client.js';

const SSE_URL = 'https://api.meshgate.test/v1/events/stream';
const HEADERS = { Authorization: 'Bearer test-key' };

function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function makeSseChunk(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Return a fake Response-shaped object directly exposing the ReadableStream body.
 * Bypasses Response constructor processing that might lock/tee the stream.
 */
function makeFakeResponse(chunks: string[]): Response {
  return { ok: true, status: 200, body: makeStream(chunks) } as unknown as Response;
}

/** Wait for a condition to be true, polling every 10ms, max 2000ms. */
async function waitFor(condition: () => boolean, label = 'condition'): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${label}`);
    await new Promise<void>((r) => setTimeout(r, 10));
  }
}

describe('SseClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('parses and delivers a well-formed SSE event', async () => {
    const received: SseEvent[] = [];
    const client = new SseClient(SSE_URL, HEADERS, {
      onEvent: (e) => received.push(e),
      onPollFallback: vi.fn(),
    });

    const spy = vi.spyOn(globalThis, 'fetch');
    spy.mockResolvedValueOnce(
      makeFakeResponse([
        makeSseChunk('approval.approved', {
          entityId: 'appr_123',
          payload: { token: 'tok_abc' },
        }),
      ]),
    );
    // Subsequent calls return an empty stream (stream ends immediately → reconnect)
    spy.mockResolvedValue(makeFakeResponse([]));

    client.start();
    await waitFor(() => received.length >= 1, 'event received');
    client.stop();

    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe('approval.approved');
    expect(received[0]?.entityId).toBe('appr_123');
    expect(received[0]?.payload).toEqual({ token: 'tok_abc' });
  });

  it('delivers multiple events from one stream', async () => {
    const received: SseEvent[] = [];
    const client = new SseClient(SSE_URL, HEADERS, {
      onEvent: (e) => received.push(e),
      onPollFallback: vi.fn(),
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeFakeResponse([
        makeSseChunk('approval.approved', { entityId: 'appr_1', payload: { token: 't1' } }),
        makeSseChunk('approval.rejected', { entityId: 'appr_2', payload: {} }),
        makeSseChunk('approval.expired', { entityId: 'appr_3', payload: {} }),
      ]),
    );

    client.start();
    await waitFor(() => received.length >= 3, '3 events received');
    client.stop();

    expect(received).toHaveLength(3);
    expect(received[0]?.type).toBe('approval.approved');
    expect(received[1]?.type).toBe('approval.rejected');
    expect(received[2]?.type).toBe('approval.expired');
  });

  it('drops events with missing entityId', async () => {
    const received: SseEvent[] = [];
    const client = new SseClient(SSE_URL, HEADERS, {
      onEvent: (e) => received.push(e),
      onPollFallback: vi.fn(),
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeFakeResponse([
        'event: some.event\ndata: {"noEntityId": true}\n\n',
        makeSseChunk('approval.approved', { entityId: 'appr_1', payload: {} }),
      ]),
    );

    client.start();
    await waitFor(() => received.length >= 1, 'valid event received');
    client.stop();

    expect(received).toHaveLength(1);
    expect(received[0]?.entityId).toBe('appr_1');
  });

  it('drops events with malformed JSON data', async () => {
    const received: SseEvent[] = [];
    const client = new SseClient(SSE_URL, HEADERS, {
      onEvent: (e) => received.push(e),
      onPollFallback: vi.fn(),
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeFakeResponse([
        'event: approval.approved\ndata: NOT_VALID_JSON\n\n',
        makeSseChunk('approval.approved', { entityId: 'appr_1', payload: {} }),
      ]),
    );

    client.start();
    await waitFor(() => received.length >= 1, 'valid event received');
    client.stop();

    // Only the valid event should be delivered
    expect(received).toHaveLength(1);
    expect(received[0]?.entityId).toBe('appr_1');
  });

  it('calls onPollFallback after exhausting reconnect attempts', async () => {
    vi.useFakeTimers();

    const fallback = vi.fn();
    const client = new SseClient(SSE_URL, HEADERS, {
      onEvent: vi.fn(),
      onPollFallback: fallback,
      onError: vi.fn(),
    });

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Network failure'));

    client.start();

    // Drain all timers (includes the 1000ms + 2000ms reconnect sleeps).
    // runAllTimersAsync repeatedly advances and awaits async callbacks until
    // no timers remain — safe because connectLoop exits after 4 failures.
    await vi.runAllTimersAsync();

    expect(fallback).toHaveBeenCalledTimes(1);
    client.stop();
  });

  it('stop() prevents further reconnects', async () => {
    const fallback = vi.fn();
    const client = new SseClient(SSE_URL, HEADERS, {
      onEvent: vi.fn(),
      onPollFallback: fallback,
    });

    // Return empty streams so connect() returns quickly
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeFakeResponse([]));

    client.start();
    // Allow the connectLoop to begin its first iteration
    await new Promise<void>((r) => setTimeout(r, 5));
    client.stop();

    // Give time to ensure no fallback fires after stop
    await new Promise<void>((r) => setTimeout(r, 50));

    expect(fallback).not.toHaveBeenCalled();
  });
});
