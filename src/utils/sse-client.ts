/**
 * SseClient — fetch-based Server-Sent Events client for @meshgate/sdk.
 *
 * Uses `fetch()` with a streaming ReadableStream — NOT `EventSource` — so it
 * works in Cloudflare Workers, Vercel Edge Runtime, and Deno (which restrict
 * or disallow `EventSource`).
 *
 * Reconnect policy (consecutive failures):
 *   1st failure → reconnect immediately
 *   2nd failure → reconnect after 1 000 ms
 *   3rd failure → reconnect after 2 000 ms
 *   4th+ failure → call onPollFallback() and stop reconnecting
 *
 * Event format (SSE wire protocol):
 *   event: <type>\n
 *   data: <JSON>\n
 *   \n
 *
 * The `data` JSON is expected to conform to `SseEvent`.
 * Malformed events are silently dropped.
 */

import type { SseEvent } from '../api/types.js';

export interface SseClientOptions {
  /** Called for every well-formed SseEvent received. */
  onEvent: (event: SseEvent) => void;
  /**
   * Called when SSE fails after all reconnect attempts.
   * The caller should switch to polling GET /v1/approvals/:id/status.
   */
  onPollFallback: () => void;
  /** Optional: called when a connection or reconnect error occurs (for logging). */
  onError?: (err: unknown) => void;
  /**
   * Reconnect delay schedule (ms). After all delays are exhausted the client
   * calls `onPollFallback` and stops reconnecting.
   * Pass `[0, 0, 0]` in tests for instant reconnect behaviour.
   * @default [0, 1_000, 2_000]
   */
  reconnectDelays?: number[];
}

/** Default reconnect delay schedule (ms). After all delays exhausted → poll fallback. */
const DEFAULT_RECONNECT_DELAYS_MS = [0, 1_000, 2_000];

export class SseClient {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly opts: SseClientOptions;
  private abortController: AbortController | null = null;
  private stopped = false;

  constructor(url: string, headers: Record<string, string>, opts: SseClientOptions) {
    this.url = url;
    this.headers = headers;
    this.opts = opts;
  }

  /** Start the SSE connection. Initiates the connect-and-reconnect loop. */
  start(): void {
    this.stopped = false;
    void this.connectLoop();
  }

  /** Stop the SSE connection permanently. No further reconnects will occur. */
  stop(): void {
    this.stopped = true;
    this.abortController?.abort();
    this.abortController = null;
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private async connectLoop(): Promise<void> {
    const delays = this.opts.reconnectDelays ?? DEFAULT_RECONNECT_DELAYS_MS;
    // +1 because delays[i] is the delay *before* attempt i+1
    const maxAttempts = delays.length + 1;
    let consecutiveFailures = 0;

    while (!this.stopped) {
      if (consecutiveFailures >= maxAttempts) {
        this.opts.onPollFallback();
        return;
      }

      // Wait before reconnecting (0ms on first attempt)
      const delayIndex = consecutiveFailures - 1;
      if (delayIndex >= 0 && delayIndex < delays.length) {
        const delay = delays[delayIndex] ?? 0;
        if (delay > 0) await sleep(delay);
      }

      if (this.stopped) return;

      try {
        const readAtLeastOneChunk = await this.connect();
        // If connect() returns cleanly the stream ended — treat as a failure.
        // But if we successfully read data, reset the failure counter so transient
        // disconnects don't count against the reconnect budget.
        if (readAtLeastOneChunk) {
          consecutiveFailures = 0;
        }
        consecutiveFailures++;
      } catch (err) {
        this.opts.onError?.(err);
        consecutiveFailures++;
      }
    }
  }

  private async connect(): Promise<boolean> {
    this.abortController = new AbortController();

    const res = await fetch(this.url, {
      method: 'GET',
      headers: { ...this.headers, Accept: 'text/event-stream' },
      signal: this.abortController.signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`SSE connection failed: HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent: Partial<SseEvent> & { data?: string } = {};
    let readAtLeastOneChunk = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        readAtLeastOneChunk = true;
        const chunk = decoder.decode(value, { stream: true });

        buffer += chunk;
        const lines = buffer.split('\n');
        // Keep the last (potentially incomplete) line in the buffer
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line === '') {
            // Blank line → dispatch event
            this.dispatchEvent(currentEvent);
            currentEvent = {};
          } else if (line.startsWith('event:')) {
            currentEvent.type = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            // Per SSE spec, multiple data: lines are joined with \n
            const chunk = line.slice(5).trim();
            currentEvent.data =
              currentEvent.data !== undefined ? `${currentEvent.data}\n${chunk}` : chunk;
          }
          // id: and retry: fields are ignored
        }
      }
    } finally {
      reader.releaseLock();
    }

    return readAtLeastOneChunk;
  }

  private dispatchEvent(raw: Partial<SseEvent> & { data?: string }): void {
    if (!raw.type || !raw.data) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.data);
    } catch {
      return; // drop malformed events
    }
    if (!isObject(parsed) || typeof parsed['entityId'] !== 'string') return;
    const event: SseEvent = {
      type: raw.type,
      entityId: parsed['entityId'],
      payload: parsed['payload'] ?? null,
    };
    this.opts.onEvent(event);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
