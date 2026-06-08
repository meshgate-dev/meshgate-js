/**
 * MeshgateApiClient — HTTP client for the Meshgate Trust Layer API.
 *
 * Wraps POST /v1/intent (with retry), GET /v1/approvals/:id/status,
 * and POST /v1/verify-token. All calls use a 10-second timeout via
 * AbortSignal.timeout (available in Node 17.3+, CF Workers, Deno, Bun).
 *
 * Retry policy for POST /v1/intent only (503/network errors):
 *   attempt 1: immediate
 *   attempt 2: 1 000 ms delay
 *   attempt 3: 2 000 ms delay
 *   → MeshgateNetworkError after 3 failures
 *
 * Error mapping (fail-closed — fn() is NEVER called on error):
 *   HTTP 400              → MeshgateConfigError
 *   HTTP 401              → MeshgateAuthError
 *   HTTP 403 intent_blocked  → MeshgateBlockedError
 *   HTTP 403 token_exhausted → MeshgateOrphanedError
 *   HTTP 403 forbidden    → MeshgateAuthError
 *   HTTP 404              → MeshgateOrphanedError
 *   HTTP 503 / network    → MeshgateNetworkError (after retries)
 */

import {
  MeshgateAuthError,
  MeshgateBlockedError,
  MeshgateConfigError,
  MeshgateNetworkError,
  MeshgateOrphanedError,
} from '../errors.js';
import type {
  ApprovalStatusResponse,
  ExternalApprovalEvidenceAppendInput,
  ExternalApprovalEvidenceEnvelope,
  ExternalApprovalRequestInput,
  ExternalApprovalStatusEnvelope,
  ExternalApprovalStatusResponse,
  IntentRequest,
  IntentResponse,
  VerifyTokenRequest,
  VerifyTokenResponse,
} from './types.js';

const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_DELAYS_MS = [0, 1_000, 2_000];

export class MeshgateApiClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(apiKey: string, baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
  }

  // ─── POST /v1/intent ───────────────────────────────────────────────────────

  async registerIntent(req: IntentRequest): Promise<IntentResponse> {
    return this.withRetry('POST /v1/intent', () =>
      this.post<IntentResponse>('/v1/intent', req, { retryOn5xx: true }),
    );
  }

  // ─── GET /v1/approvals/:id/status ─────────────────────────────────────────

  getApprovalStatus(approvalId: string): Promise<ApprovalStatusResponse> {
    return this.get<ApprovalStatusResponse>(
      `/v1/approvals/${encodeURIComponent(approvalId)}/status`,
    );
  }

  // ─── External approval requests ───────────────────────────────────────────

  async createApprovalRequest(
    req: ExternalApprovalRequestInput,
  ): Promise<ExternalApprovalStatusResponse> {
    const res = await this.withRetry('POST /v1/approval-requests', () =>
      this.post<ExternalApprovalStatusEnvelope>('/v1/approval-requests', req, {
        retryOn5xx: true,
      }),
    );
    return res.data;
  }

  async getExternalApprovalRequest(approvalId: string): Promise<ExternalApprovalStatusResponse> {
    const res = await this.get<ExternalApprovalStatusEnvelope>(
      `/v1/approval-requests/${encodeURIComponent(approvalId)}`,
    );
    return res.data;
  }

  async appendApprovalRequestEvidence(
    approvalId: string,
    req: ExternalApprovalEvidenceAppendInput,
  ): Promise<ExternalApprovalEvidenceEnvelope['data']> {
    const res = await this.withRetry('POST /v1/approval-requests/:approvalId/evidence', () =>
      this.post<ExternalApprovalEvidenceEnvelope>(
        `/v1/approval-requests/${encodeURIComponent(approvalId)}/evidence`,
        req,
        { retryOn5xx: true },
      ),
    );
    return res.data;
  }

  // ─── POST /v1/verify-token ─────────────────────────────────────────────────

  verifyToken(req: VerifyTokenRequest): Promise<VerifyTokenResponse> {
    return this.withRetry('POST /v1/verify-token', () =>
      this.post<VerifyTokenResponse>('/v1/verify-token', req, { retryOn5xx: true }),
    );
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private async get<T>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: this.headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new MeshgateNetworkError(`Network error: ${String(err)}`);
    }
    return this.parseResponse<T>(res);
  }

  private async post<T>(path: string, body: unknown, opts: { retryOn5xx: boolean }): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new MeshgateNetworkError(`Network error: ${String(err)}`);
    }
    if (opts.retryOn5xx && res.status >= 500) {
      // Signal to withRetry that this attempt should be retried
      throw new RetryableError(`HTTP ${res.status} from ${path}`);
    }
    return this.parseResponse<T>(res);
  }

  private async withRetry<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    let nextDelayMs = 0;

    for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
      if (nextDelayMs > 0) {
        await sleep(nextDelayMs);
      }

      try {
        return await fn();
      } catch (err) {
        if (err instanceof RetryableError || err instanceof MeshgateNetworkError) {
          lastErr = err;
          nextDelayMs =
            err instanceof RetryableError && err.retryAfterMs !== undefined
              ? err.retryAfterMs
              : (RETRY_DELAYS_MS[i + 1] ?? 0);
          continue;
        }
        throw err;
      }
    }
    if (lastErr instanceof MeshgateNetworkError) throw lastErr;
    throw new MeshgateNetworkError(
      `${operation} failed after ${RETRY_DELAYS_MS.length} attempts: ${String(lastErr)}`,
    );
  }

  private async parseResponse<T>(res: Response): Promise<T> {
    if (res.ok) {
      return res.json() as Promise<T>;
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      // ignore parse errors — use status code only
    }

    const error = typeof body['error'] === 'string' ? body['error'] : '';

    switch (res.status) {
      case 400:
        throw new MeshgateConfigError(`Bad request: ${error || res.statusText}`);
      case 401:
        throw new MeshgateAuthError(`Unauthorized: ${error || res.statusText}`);
      case 403:
        if (error === 'intent_blocked') {
          throw new MeshgateBlockedError(`Intent blocked by policy`);
        }
        if (error === 'token_exhausted') {
          throw new MeshgateOrphanedError(
            `Token already consumed`,
            undefined,
            undefined,
            'token_exhausted',
          );
        }
        throw new MeshgateAuthError(`Forbidden: ${error || res.statusText}`);
      case 404:
        throw new MeshgateOrphanedError(
          `Resource not found: ${error || res.statusText}`,
          undefined,
          undefined,
          'not_found',
        );
      case 422:
        throw new MeshgateConfigError(`Unprocessable entity: ${error || res.statusText}`);
      case 429: {
        throw new RetryableError(
          `HTTP 429 rate limit`,
          parseRetryAfterMs(res.headers.get('Retry-After')),
        );
      }
      case 503:
        throw new MeshgateNetworkError(`Service unavailable (503)`);
      default:
        throw new MeshgateNetworkError(`Unexpected HTTP ${res.status}: ${error || res.statusText}`);
    }
  }
}

/** Internal signal: retryable response that should trigger another attempt. */
class RetryableError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }

  const retryAt = Date.parse(value);
  if (Number.isNaN(retryAt)) return undefined;
  return Math.max(0, retryAt - Date.now());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
