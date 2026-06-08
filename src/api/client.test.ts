import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MeshgateAuthError,
  MeshgateBlockedError,
  MeshgateConfigError,
  MeshgateNetworkError,
  MeshgateOrphanedError,
} from '../errors.js';
import { MeshgateApiClient } from './client.js';
import type { IntentRequest } from './types.js';

const BASE_URL = 'https://api.meshgate.test';
const API_KEY = 'test-key-123';

const baseIntentReq: IntentRequest = {
  intent: 'process_refund',
  payloadHash: 'aGVsbG8=',
  gateNonce: 'bm9uY2U=',
};

function makeRes(status: number, body: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('MeshgateApiClient', () => {
  let client: MeshgateApiClient;

  beforeEach(() => {
    client = new MeshgateApiClient(API_KEY, BASE_URL);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── registerIntent ────────────────────────────────────────────────────────

  describe('registerIntent', () => {
    it('returns IntentResponse on 200 (allowed)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        makeRes(200, { outcome: 'allowed', intent: 'process_refund', matchedPolicy: {} }),
      );
      const res = await client.registerIntent(baseIntentReq);
      expect(res.outcome).toBe('allowed');
    });

    it('returns IntentResponse on 201 (gated)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        makeRes(201, {
          outcome: 'gated',
          approvalId: 'appr_123',
          intent: 'process_refund',
          expiresAt: '2099-01-01T00:00:00Z',
        }),
      );
      const res = await client.registerIntent(baseIntentReq);
      expect(res.outcome).toBe('gated');
      if (res.outcome === 'gated') {
        expect(res.approvalId).toBe('appr_123');
      }
    });

    it('throws MeshgateBlockedError on 403 intent_blocked', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        makeRes(403, { error: 'intent_blocked' }),
      );
      await expect(client.registerIntent(baseIntentReq)).rejects.toBeInstanceOf(
        MeshgateBlockedError,
      );
    });

    it('throws MeshgateAuthError on 401', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeRes(401, { error: 'unauthorized' }));
      await expect(client.registerIntent(baseIntentReq)).rejects.toBeInstanceOf(MeshgateAuthError);
    });

    it('throws MeshgateConfigError on 400', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeRes(400, { error: 'bad_request' }));
      await expect(client.registerIntent(baseIntentReq)).rejects.toBeInstanceOf(
        MeshgateConfigError,
      );
    });

    it('retries on 503 and succeeds on second attempt', async () => {
      const spy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(makeRes(503, {}))
        .mockResolvedValueOnce(
          makeRes(201, {
            outcome: 'gated',
            approvalId: 'appr_456',
            intent: 'process_refund',
            expiresAt: '2099-01-01T00:00:00Z',
          }),
        );
      const res = await client.registerIntent(baseIntentReq);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(res.outcome).toBe('gated');
    });

    it('retries on 429 using Retry-After and succeeds on second attempt', async () => {
      const spy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(makeRes(429, { error: 'rate_limited' }, { 'Retry-After': '0' }))
        .mockResolvedValueOnce(
          makeRes(201, {
            outcome: 'gated',
            approvalId: 'appr_rate_limited',
            intent: 'process_refund',
            expiresAt: '2099-01-01T00:00:00Z',
          }),
        );

      const res = await client.registerIntent(baseIntentReq);

      expect(spy).toHaveBeenCalledTimes(2);
      expect(res.outcome).toBe('gated');
    });

    it('throws MeshgateNetworkError after 3 consecutive 503s', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeRes(503, {}));
      await expect(client.registerIntent(baseIntentReq)).rejects.toBeInstanceOf(
        MeshgateNetworkError,
      );
    });

    it('throws MeshgateNetworkError on network failure', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
      await expect(client.registerIntent(baseIntentReq)).rejects.toBeInstanceOf(
        MeshgateNetworkError,
      );
    });
  });

  // ─── getApprovalStatus ─────────────────────────────────────────────────────

  describe('getApprovalStatus', () => {
    it('returns ApprovalStatusResponse on 200', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        makeRes(200, {
          id: 'appr_123',
          status: 'approved',
          resolvedAt: '2099-01-01T00:00:00Z',
          token: 'tok_abc',
          gateNonce: 'bm9uY2U=',
        }),
      );
      const res = await client.getApprovalStatus('appr_123');
      expect(res.status).toBe('approved');
      expect(res.token).toBe('tok_abc');
    });

    it('URL-encodes the approvalId', async () => {
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        makeRes(200, {
          id: 'a/b',
          status: 'pending',
          resolvedAt: null,
          token: null,
          gateNonce: null,
        }),
      );
      await client.getApprovalStatus('a/b');
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('/a%2Fb/'), expect.any(Object));
    });

    it('throws MeshgateOrphanedError on 404', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeRes(404, { error: 'not_found' }));
      await expect(client.getApprovalStatus('appr_missing')).rejects.toBeInstanceOf(
        MeshgateOrphanedError,
      );
    });
  });

  // ─── external approval requests ───────────────────────────────────────────

  describe('external approval requests', () => {
    it('creates an external approval request and unwraps the data envelope', async () => {
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        makeRes(201, {
          data: {
            approvalId: 'app_ext_123',
            status: 'pending',
            sourceSystem: 'openai-agents',
            externalRequestId: null,
            actionName: 'send_wire',
            actionSummary: 'Send a wire transfer',
            payloadSummary: null,
            payloadRef: null,
            policyEngine: 'agt',
            policyId: null,
            ruleId: null,
            riskLevel: 'high',
            resumeMode: 'poll',
            eventFilter: {
              entityType: 'approval',
              entityId: 'app_ext_123',
              eventTypes: ['approval.approved', 'approval.rejected', 'approval.expired'],
            },
            decision: null,
            evidence: [],
            expiresAt: '2099-01-01T00:00:00Z',
            createdAt: '2026-06-01T00:00:00Z',
          },
        }),
      );

      const res = await client.createApprovalRequest({
        sourceSystem: 'openai-agents',
        actionName: 'send_wire',
        actionSummary: 'Send a wire transfer',
        policyEngine: 'agt',
        riskLevel: 'high',
        idempotencyKey: 'run_123:send_wire',
      });

      expect(res.approvalId).toBe('app_ext_123');
      const [url, init] = spy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${BASE_URL}/v1/approval-requests`);
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
    });

    it('gets an external approval request and URL-encodes the approvalId', async () => {
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        makeRes(200, {
          data: {
            approvalId: 'app/a',
            status: 'approved',
            sourceSystem: 'custom-runtime',
            externalRequestId: null,
            actionName: 'release_message',
            actionSummary: 'Release quarantined message',
            payloadSummary: null,
            payloadRef: null,
            policyEngine: null,
            policyId: null,
            ruleId: null,
            riskLevel: null,
            resumeMode: 'events',
            eventFilter: {
              entityType: 'approval',
              entityId: 'app/a',
              eventTypes: ['approval.approved', 'approval.rejected', 'approval.expired'],
            },
            decision: {
              outcome: 'approved',
              resolvedAt: '2026-06-01T00:01:00Z',
              note: null,
            },
            evidence: [],
            expiresAt: null,
            createdAt: '2026-06-01T00:00:00Z',
          },
        }),
      );

      const res = await client.getExternalApprovalRequest('app/a');

      expect(res.status).toBe('approved');
      expect(spy).toHaveBeenCalledWith(
        `${BASE_URL}/v1/approval-requests/app%2Fa`,
        expect.any(Object),
      );
    });

    it('appends approval-linked evidence and unwraps the data envelope', async () => {
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        makeRes(201, {
          data: {
            id: 'evd_123',
            evidenceType: 'risk_signal',
            label: 'Prompt injection detector',
            summary: 'Matched instruction override text.',
            outcome: 'flagged',
            riskLevel: 'high',
            policyId: null,
            ruleId: null,
            traceId: 'trace_123',
            payloadRef: null,
            redactionState: 'summary_only',
            createdAt: '2026-06-01T00:00:00Z',
          },
        }),
      );

      const res = await client.appendApprovalRequestEvidence('app_ext_123', {
        evidenceType: 'risk_signal',
        label: 'Prompt injection detector',
        summary: 'Matched instruction override text.',
        outcome: 'flagged',
        riskLevel: 'high',
        traceId: 'trace_123',
        redactionState: 'summary_only',
        idempotencyKey: 'run_123:risk_signal',
      });

      expect(res.id).toBe('evd_123');
      expect(spy).toHaveBeenCalledWith(
        `${BASE_URL}/v1/approval-requests/app_ext_123/evidence`,
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  // ─── verifyToken ───────────────────────────────────────────────────────────

  describe('verifyToken', () => {
    it('returns VerifyTokenResponse on 200', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        makeRes(200, {
          verified: true,
          context: {
            approvalId: 'appr_123',
            intent: 'process_refund',
            approvedBy: 'alice@example.com',
            payloadHash: 'aGVsbG8=',
            gateNonce: 'bm9uY2U=',
            resolvedAt: '2099-01-01T00:00:00Z',
          },
        }),
      );
      const res = await client.verifyToken({ approvalId: 'appr_123', token: 'tok_abc' });
      expect(res.verified).toBe(true);
      expect(res.context.approvedBy).toBe('alice@example.com');
    });

    it('throws MeshgateOrphanedError on 403 token_exhausted', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        makeRes(403, { error: 'token_exhausted' }),
      );
      await expect(
        client.verifyToken({ approvalId: 'appr_123', token: 'tok_burned' }),
      ).rejects.toBeInstanceOf(MeshgateOrphanedError);
    });

    it('throws MeshgateAuthError on 403 forbidden', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeRes(403, { error: 'forbidden' }));
      await expect(
        client.verifyToken({ approvalId: 'appr_123', token: 'tok_abc' }),
      ).rejects.toBeInstanceOf(MeshgateAuthError);
    });

    it('retries on 503 and throws MeshgateNetworkError after 3 attempts', async () => {
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeRes(503, {}));
      await expect(
        client.verifyToken({ approvalId: 'appr_123', token: 'tok_abc' }),
      ).rejects.toThrow('POST /v1/verify-token failed after 3 attempts');
      // 3 attempts total (same retry policy as registerIntent)
      expect(spy).toHaveBeenCalledTimes(3);
    });
  });
});
