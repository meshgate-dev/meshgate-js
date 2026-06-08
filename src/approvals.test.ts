import { afterEach, describe, expect, it, vi } from 'vitest';

import { NoopAdapter } from './adapters/noop-adapter.js';
import { MeshgateApprovalClient } from './approvals.js';
import { MeshgateClient } from './client.js';
import { MeshgateWaitTimeoutError } from './errors.js';

const BASE_URL = 'https://api.meshgate.test';
const API_KEY = 'mg_test_external_approvals';
const LOCAL_SECRET = 'a'.repeat(32);

function makeRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function approvalEnvelope(status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled') {
  return {
    data: {
      approvalId: 'app_ext_123',
      status,
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
      decision:
        status === 'pending'
          ? null
          : {
              outcome: status,
              resolvedAt: '2026-06-01T00:01:00Z',
              note: null,
            },
      evidence: [],
      expiresAt: '2099-01-01T00:00:00Z',
      createdAt: '2026-06-01T00:00:00Z',
    },
  };
}

describe('MeshgateApprovalClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('can be used as a standalone external approval helper', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeRes(201, approvalEnvelope('pending')));
    const approvals = new MeshgateApprovalClient({ apiKey: API_KEY, baseUrl: BASE_URL });

    const approval = await approvals.request({
      sourceSystem: 'openai-agents',
      actionName: 'send_wire',
      actionSummary: 'Send a wire transfer',
      riskLevel: 'high',
      idempotencyKey: 'run_123:send_wire',
    });

    expect(approval.approvalId).toBe('app_ext_123');
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/v1/approval-requests`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
  });

  it('is exposed on MeshgateClient without changing the guarded runtime path', () => {
    const client = new MeshgateClient({
      apiKey: API_KEY,
      localEncryptionKey: LOCAL_SECRET,
      storageAdapter: new NoopAdapter(),
      baseUrl: BASE_URL,
    });

    expect(client.approvals).toBeInstanceOf(MeshgateApprovalClient);
    expect('approve' in client.approvals).toBe(false);
    expect('reject' in client.approvals).toBe(false);
  });

  it('polls until an external approval reaches a terminal decision', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeRes(200, approvalEnvelope('pending')))
      .mockResolvedValueOnce(makeRes(200, approvalEnvelope('approved')));

    const approvals = new MeshgateApprovalClient({ apiKey: API_KEY, baseUrl: BASE_URL });
    const approval = await approvals.waitForDecision('app_ext_123', {
      pollIntervalMs: 0,
      timeoutMs: 1_000,
    });

    expect(approval.status).toBe('approved');
    expect(approval.decision?.outcome).toBe('approved');
  });

  it('times out locally without recording a decision', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeRes(200, approvalEnvelope('pending')));

    const approvals = new MeshgateApprovalClient({ apiKey: API_KEY, baseUrl: BASE_URL });

    await expect(
      approvals.waitForDecision('app_ext_123', {
        pollIntervalMs: 0,
        timeoutMs: 0,
      }),
    ).rejects.toBeInstanceOf(MeshgateWaitTimeoutError);
  });
});
