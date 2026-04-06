/**
 * Tests for key rotation detection on reconcile (MG23-004 / RID-020, RID-021).
 *
 * When MESHGATE_LOCAL_SECRET changes between gate creation and reconcile,
 * AES-GCM decryption fails. The SDK must fire onGateOrphaned with
 * reason: 'decryption_failed' rather than crashing or silently failing.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeshgateStorageAdapter } from './adapters/types.js';
import { MeshgateClient } from './client.js';
import type { GateOrphanedEvent, ReconcileResult, StoredGateRecord } from './types.js';

// Test-only helper to invoke the private _reconcile() method
function reconcile(client: MeshgateClient): Promise<ReconcileResult> {
  return (client as unknown as { _reconcile(): Promise<ReconcileResult> })._reconcile();
}

const API_KEY = 'mg_test_key_rotation';
// KEY_B simulates MESHGATE_LOCAL_SECRET rotation (different from original KEY_A used to encrypt)
const KEY_B = 'z'.repeat(32);

function makeJsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * A stored gate record encrypted with KEY_A but loaded by a client using KEY_B.
 * ciphertext/iv/authTag are from a real encryption with KEY_A, so decryption
 * with KEY_B will fail with an AES-GCM auth tag error.
 *
 * We use obviously-invalid base64 values to guarantee a decryption failure
 * regardless of the key, simulating a key-rotation scenario.
 */
const ENCRYPTED_WITH_KEY_A: StoredGateRecord = {
  schemaVersion: '1',
  approvalId: 'appr_key_rot',
  intent: 'rotate_test',
  expiresAt: new Date(Date.now() + 86400_000).toISOString(),
  // Garbage ciphertext/iv/authTag — will always fail decryption
  iv: 'aW52YWxpZA==',
  authTag: 'YXV0aFRhZ0ludmFsaWQ=',
  ciphertext: 'Y2lwaGVydGV4dEludmFsaWQ=',
};

describe('key rotation detection on reconcile', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fires onGateOrphaned with reason=decryption_failed when decryption fails on reconcile', async () => {
    const orphanedEvents: GateOrphanedEvent[] = [];

    const adapter: MeshgateStorageAdapter = {
      listKeys: () => Promise.resolve(['appr_key_rot']),
      get: () => Promise.resolve(JSON.stringify(ENCRYPTED_WITH_KEY_A)),
      set: () => Promise.resolve(),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    // Cloud status: approved with a token
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        makeJsonRes(200, {
          id: 'appr_key_rot',
          status: 'approved',
          resolvedAt: '2099-01-01T01:00:00Z',
          token: 'tok_key_rot',
          gateNonce: null,
        }),
      )
      // verify-token: returns a valid gateNonce (decryption will fail afterward)
      .mockResolvedValueOnce(
        makeJsonRes(200, {
          verified: true,
          context: {
            approvalId: 'appr_key_rot',
            intent: 'rotate_test',
            approvedBy: 'alice@example.com',
            payloadHash: null,
            // Return a valid-looking nonce — decryption will still fail due to wrong key
            gateNonce: 'bm9uY2VfMTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0',
            resolvedAt: '2099-01-01T01:00:00Z',
          },
        }),
      );

    const client = new MeshgateClient({
      apiKey: API_KEY,
      localEncryptionKey: KEY_B, // different key than what encrypted the gate
      storageAdapter: adapter,
      hooks: {
        onGateOrphaned: (e) => void orphanedEvents.push(e),
      },
    });

    // Register the handler so reconcile doesn't orphan it for "missing handler"
    client.guard(() => Promise.resolve('rotated'), { intent: 'rotate_test' });

    const result = await reconcile(client);

    expect(result.orphaned).toHaveLength(1);
    expect(orphanedEvents).toHaveLength(1);
    expect(orphanedEvents[0]?.reason).toBe('decryption_failed');
    expect(orphanedEvents[0]?.approvalId).toBe('appr_key_rot');
  });

  it('decryption_failed message mentions key rotation', async () => {
    const orphanedEvents: GateOrphanedEvent[] = [];

    const adapter: MeshgateStorageAdapter = {
      listKeys: () => Promise.resolve(['appr_key_rot_msg']),
      get: () => Promise.resolve(JSON.stringify({ ...ENCRYPTED_WITH_KEY_A, approvalId: 'appr_key_rot_msg' })),
      set: () => Promise.resolve(),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        makeJsonRes(200, {
          id: 'appr_key_rot_msg',
          status: 'approved',
          resolvedAt: '2099-01-01T01:00:00Z',
          token: 'tok_rot_msg',
          gateNonce: null,
        }),
      )
      .mockResolvedValueOnce(
        makeJsonRes(200, {
          verified: true,
          context: {
            approvalId: 'appr_key_rot_msg',
            intent: 'rotate_test',
            approvedBy: null,
            payloadHash: null,
            gateNonce: 'bm9uY2VfMTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0',
            resolvedAt: '2099-01-01T01:00:00Z',
          },
        }),
      );

    const client = new MeshgateClient({
      apiKey: API_KEY,
      localEncryptionKey: KEY_B,
      storageAdapter: adapter,
      hooks: { onGateOrphaned: (e) => void orphanedEvents.push(e) },
    });
    client.guard(() => Promise.resolve('rotated'), { intent: 'rotate_test' });

    await reconcile(client);

    const msg = orphanedEvents[0]?.message ?? '';
    // RID-021: message must mention key rotation
    expect(msg.toLowerCase()).toContain('key');
  });

  it('gate record is deleted after decryption_failed', async () => {
    const deleteMock = vi.fn().mockResolvedValue(undefined);
    const adapter: MeshgateStorageAdapter = {
      listKeys: () => Promise.resolve(['appr_key_rot_del']),
      get: () => Promise.resolve(JSON.stringify({ ...ENCRYPTED_WITH_KEY_A, approvalId: 'appr_key_rot_del' })),
      set: () => Promise.resolve(),
      delete: deleteMock,
    };

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        makeJsonRes(200, {
          id: 'appr_key_rot_del',
          status: 'approved',
          resolvedAt: '2099-01-01T01:00:00Z',
          token: 'tok_del',
          gateNonce: null,
        }),
      )
      .mockResolvedValueOnce(
        makeJsonRes(200, {
          verified: true,
          context: {
            approvalId: 'appr_key_rot_del',
            intent: 'rotate_test',
            approvedBy: null,
            payloadHash: null,
            gateNonce: 'bm9uY2VfMTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0',
            resolvedAt: '2099-01-01T01:00:00Z',
          },
        }),
      );

    const client = new MeshgateClient({
      apiKey: API_KEY,
      localEncryptionKey: KEY_B,
      storageAdapter: adapter,
      hooks: { onGateOrphaned: () => {} },
    });
    client.guard(() => Promise.resolve('rotated'), { intent: 'rotate_test' });

    await reconcile(client);

    expect(deleteMock).toHaveBeenCalledWith('appr_key_rot_del');
  });
});
