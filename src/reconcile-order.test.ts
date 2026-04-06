/**
 * Tests for reconcile() ordering (MG23-004 / RID-026).
 *
 * Approved gates must be processed in resolvedAt desc order (most recent first).
 * Pending gates must be processed in createdAt asc order (oldest first, FIFO).
 *
 * Since creating fully-decryptable gate records requires running the real
 * AES-GCM encryption, the approved-ordering tests use records with garbage
 * ciphertext that will always fail decryption. Ordering is verified by
 * checking the order in which result.orphaned[] receives gates (which reflects
 * the processing order) rather than result.resumed[].
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeshgateStorageAdapter } from './adapters/types.js';
import { MeshgateClient } from './client.js';
import type { GateInfo, ReconcileResult, StoredGateRecord } from './types.js';

// Test-only helper to invoke the private _reconcile() method
function reconcile(client: MeshgateClient): Promise<ReconcileResult> {
  return (client as unknown as { _reconcile(): Promise<ReconcileResult> })._reconcile();
}

const API_KEY = 'mg_test_order';
const LOCAL_SECRET = 'd'.repeat(32);

function makeJsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * A gate record with garbage ciphertext — always fails decryption after
 * verify-token succeeds. Goes to orphaned (decryption_failed), not resumed.
 * We use this to test processing ORDER without needing real encrypted records.
 */
function makeGarbageRecord(approvalId: string, createdAt: number): StoredGateRecord {
  return {
    schemaVersion: '1',
    approvalId,
    intent: 'order_test',
    expiresAt: new Date(Date.now() + 86400_000).toISOString(),
    iv: 'aW52YWxpZA==',
    authTag: 'YXV0aFRhZ0ludmFsaWQ=',
    ciphertext: 'Y2lwaGVydGV4dA==',
    createdAt,
  };
}

function makeStatusRes(id: string, resolvedAt: string, token: string): Response {
  return makeJsonRes(200, {
    id,
    status: 'approved',
    resolvedAt,
    token,
    gateNonce: null,
  });
}

function makeVerifyRes(approvalId: string, nonce = 'bm9uY2VfMTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0'): Response {
  return makeJsonRes(200, {
    verified: true,
    context: {
      approvalId,
      intent: 'order_test',
      approvedBy: null,
      payloadHash: null,
      gateNonce: nonce,
      resolvedAt: '2099-01-01T00:00:00Z',
    },
  });
}

describe('reconcile() ordering — approved gates sorted by resolvedAt desc', () => {
  afterEach(() => vi.restoreAllMocks());

  it('processes approved gates with newer resolvedAt first (desc order)', async () => {
    const gateOldId = 'appr_resolved_old'; // resolvedAt: 2024-01-01 (older)
    const gateNewId = 'appr_resolved_new'; // resolvedAt: 2024-06-01 (newer → processed first)

    const adapter: MeshgateStorageAdapter = {
      // listKeys returns old first, but reconcile should sort by resolvedAt desc
      listKeys: () => Promise.resolve([gateOldId, gateNewId]),
      get: (id) => Promise.resolve(JSON.stringify(makeGarbageRecord(id, 1000))),
      set: () => Promise.resolve(),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    vi.spyOn(globalThis, 'fetch')
      // Status checks (sequential, in listKeys order)
      .mockResolvedValueOnce(makeStatusRes(gateOldId, '2024-01-01T00:00:00Z', 'tok_old'))
      .mockResolvedValueOnce(makeStatusRes(gateNewId, '2024-06-01T00:00:00Z', 'tok_new'))
      // verify-token: gateNew processed first (newer resolvedAt)
      .mockResolvedValueOnce(makeVerifyRes(gateNewId))
      // verify-token: gateOld processed second
      .mockResolvedValueOnce(makeVerifyRes(gateOldId));

    const client = new MeshgateClient({
      apiKey: API_KEY,
      localEncryptionKey: LOCAL_SECRET,
      storageAdapter: adapter,
      hooks: { onGateOrphaned: () => {} },
    });
    client.guard(() => Promise.resolve('ok'), { intent: 'order_test' });

    const result = await reconcile(client);

    // Both gates fail decryption (garbage ciphertext) → orphaned
    expect(result.orphaned).toHaveLength(2);

    // Orphaned list reflects processing order: gateNew (newer resolvedAt) is first
    const orphanedIds = result.orphaned.map((g: GateInfo) => g.approvalId);
    expect(orphanedIds[0]).toBe(gateNewId);
    expect(orphanedIds[1]).toBe(gateOldId);
  });

  it('gates without resolvedAt sort to the end (resolvedAt treated as 0)', async () => {
    const gateWithDate = 'appr_with_date';
    const gateNoDate = 'appr_no_date';

    const adapter: MeshgateStorageAdapter = {
      listKeys: () => Promise.resolve([gateNoDate, gateWithDate]),
      get: (id) => Promise.resolve(JSON.stringify(makeGarbageRecord(id, 1000))),
      set: () => Promise.resolve(),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        makeJsonRes(200, { id: gateNoDate, status: 'approved', resolvedAt: null, token: 'tok_nodateA', gateNonce: null }),
      )
      .mockResolvedValueOnce(makeStatusRes(gateWithDate, '2024-03-15T00:00:00Z', 'tok_dated'))
      // gateWithDate processed first (resolvedAt > 0 > gateNoDate which has null/NaN)
      .mockResolvedValueOnce(makeVerifyRes(gateWithDate))
      .mockResolvedValueOnce(makeVerifyRes(gateNoDate));

    const client = new MeshgateClient({
      apiKey: API_KEY,
      localEncryptionKey: LOCAL_SECRET,
      storageAdapter: adapter,
      hooks: { onGateOrphaned: () => {} },
    });
    client.guard(() => Promise.resolve('ok'), { intent: 'order_test' });

    const result = await reconcile(client);
    expect(result.orphaned).toHaveLength(2);
    // Gate with a resolvedAt should be processed first
    expect(result.orphaned[0]?.approvalId).toBe(gateWithDate);
  });
});

describe('reconcile() ordering — pending gates sorted by createdAt asc', () => {
  afterEach(() => vi.restoreAllMocks());

  it('adds pending gates to result.pending in createdAt asc order (FIFO)', async () => {
    const gateOldId = 'appr_old_pending'; // createdAt: 1000 (oldest → first)
    const gateNewId = 'appr_new_pending'; // createdAt: 9000 (newest → second)

    const adapter: MeshgateStorageAdapter = {
      // listKeys returns newest first — sort should override storage order
      listKeys: () => Promise.resolve([gateNewId, gateOldId]),
      get: (id) => {
        const createdAt = id === gateOldId ? 1000 : 9000;
        return Promise.resolve(JSON.stringify({
          ...makeGarbageRecord(id, createdAt),
          intent: 'pending_order',
        }));
      },
      set: () => Promise.resolve(),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    vi.spyOn(globalThis, 'fetch')
      // Status for gateNew (first in listKeys)
      .mockResolvedValueOnce(
        makeJsonRes(200, { id: gateNewId, status: 'pending', resolvedAt: null, token: null, gateNonce: null }),
      )
      // Status for gateOld
      .mockResolvedValueOnce(
        makeJsonRes(200, { id: gateOldId, status: 'pending', resolvedAt: null, token: null, gateNonce: null }),
      )
      // SSE connection (close immediately)
      .mockResolvedValueOnce(
        new Response(new ReadableStream({ start(c) { c.close(); } }), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );

    const client = new MeshgateClient({
      apiKey: API_KEY,
      localEncryptionKey: LOCAL_SECRET,
      storageAdapter: adapter,
    });
    client.guard(() => Promise.resolve('pend'), { intent: 'pending_order' });

    const result = await reconcile(client);

    expect(result.pending).toHaveLength(2);
    // gateOld (createdAt: 1000) should be first — oldest FIFO
    expect(result.pending[0]?.approvalId).toBe(gateOldId);
    expect(result.pending[1]?.approvalId).toBe(gateNewId);
  });
});
