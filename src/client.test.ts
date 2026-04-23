/**
 * Tests for MeshgateClient (Phase 6 — MG22-013 through MG22-017).
 *
 * All tests run without network access. fetch is mocked via vi.spyOn.
 * The NoopAdapter is used to avoid filesystem I/O.
 *
 * Test tiers:
 *   Tier 1 — constructor validation (no I/O)
 *   Tier 2 — guard() allowed / blocked flows (mock HTTP)
 *   Tier 3 — guard() gated flow (mock HTTP + mock SSE stream)
 *   Tier 4 — startup reconcile (mock HTTP + mock adapter)
 *   Tier 5 — @guardrail decorator
 */

/* eslint-disable @typescript-eslint/require-await */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { guardrail } from './decorators.js';
import { NoopAdapter } from './adapters/noop-adapter.js';
import type { MeshgateStorageAdapter } from './adapters/types.js';
import { MeshgateClient, validateIntentArgsFlatness, validateSerializable } from './client.js';
import {
  MeshgateBlockedError,
  MeshgateConfigError,
  MeshgateExpiredError,
  MeshgateOrphanedError,
  MeshgateRejectedError,
  MeshgateSerializationError,
  MeshgateTamperError,
} from './errors.js';
import type { GateInfo, ReconcileResult, StoredGateRecord } from './types.js';

// Test-only helper: access the private _reconcile() method without exposing it
// in the public API surface.
function reconcile(client: MeshgateClient): Promise<ReconcileResult> {
  return (client as unknown as { _reconcile(): Promise<ReconcileResult> })._reconcile();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const API_KEY = 'mg_test_abc123';
const LOCAL_SECRET = 'a'.repeat(32); // exactly 32 chars

function makeClient(overrides: Partial<ConstructorParameters<typeof MeshgateClient>[0]> = {}) {
  return new MeshgateClient({
    apiKey: API_KEY,
    localEncryptionKey: LOCAL_SECRET,
    storageAdapter: new NoopAdapter(),
    ...overrides,
  });
}

function makeJsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeAllowedRes() {
  return makeJsonRes(200, { outcome: 'allowed', intent: 'test_intent', matchedPolicy: {} });
}

function makeBlockedRes() {
  return makeJsonRes(403, { error: 'intent_blocked', outcome: 'blocked', intent: 'test_intent', matchedPolicy: {} });
}

function makeGatedRes(approvalId = 'appr_001', expiresAt = '2099-01-01T00:00:00Z') {
  return makeJsonRes(201, {
    outcome: 'gated',
    approvalId,
    intent: 'test_intent',
    expiresAt,
  });
}

function makeVerifyRes(
  approvalId = 'appr_001',
  payloadHash: string | null = null,
  gateNonce: string | null = 'bm9uY2VfMTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0',
) {
  return makeJsonRes(200, {
    verified: true,
    context: {
      approvalId,
      intent: 'test_intent',
      approvedBy: 'alice@example.com',
      payloadHash,
      gateNonce,
      resolvedAt: '2099-01-01T01:00:00Z',
    },
  });
}

/** Build a mock SSE response that emits one event then closes. */
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

function makeSseRejectedStream(approvalId: string): Response {
  const encoder = new TextEncoder();
  const data = JSON.stringify({ entityId: approvalId, payload: {} });
  const chunk = encoder.encode(`event: approval.rejected\ndata: ${data}\n\n`);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function makeSseExpiredStream(approvalId: string): Response {
  const encoder = new TextEncoder();
  const data = JSON.stringify({ entityId: approvalId, payload: {} });
  const chunk = encoder.encode(`event: approval.expired\ndata: ${data}\n\n`);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/**
 * Set up fetch mocks for the full gated flow. The gateNonce is captured from
 * the POST /v1/intent request body and echoed back in the verify-token response
 * so AES-GCM decryption succeeds.
 */
function setupGatedFlowMocks(approvalId: string, token: string, sseStream: Response) {
  let capturedGateNonce: string | null = null;

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;

    if (url.endsWith('/v1/intent')) {
      const body = JSON.parse((init?.body as string) ?? '{}') as { gateNonce?: string };
      capturedGateNonce = body.gateNonce ?? null;
      return makeGatedRes(approvalId);
    }
    if (url.includes('/v1/events/stream')) {
      return sseStream;
    }
    if (url.endsWith('/v1/verify-token')) {
      return makeVerifyRes(approvalId, null, capturedGateNonce);
    }
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  });
}

// ─── §1 — Constructor validation ─────────────────────────────────────────────

describe('MeshgateClient — constructor', () => {
  it('throws MeshgateConfigError when apiKey is missing', () => {
    expect(
      () => new MeshgateClient({ apiKey: '', localEncryptionKey: LOCAL_SECRET }),
    ).toThrow(MeshgateConfigError);
  });

  it('throws MeshgateConfigError when apiKey is whitespace only', () => {
    expect(
      () => new MeshgateClient({ apiKey: '   ', localEncryptionKey: LOCAL_SECRET }),
    ).toThrow(MeshgateConfigError);
  });

  it('throws MeshgateConfigError when localEncryptionKey is too short', () => {
    expect(
      () => new MeshgateClient({ apiKey: API_KEY, localEncryptionKey: 'short' }),
    ).toThrow(MeshgateConfigError);
  });

  it('throws MeshgateConfigError when localEncryptionKey is exactly 31 chars', () => {
    expect(
      () => new MeshgateClient({ apiKey: API_KEY, localEncryptionKey: 'a'.repeat(31) }),
    ).toThrow(MeshgateConfigError);
  });

  it('does not throw with valid 32-char localEncryptionKey', () => {
    expect(() => makeClient()).not.toThrow();
  });

  it('uses NoopAdapter when explicitly provided', () => {
    // Should not throw (NoopAdapter doesn't touch filesystem)
    expect(() => makeClient({ storageAdapter: new NoopAdapter() })).not.toThrow();
  });

  it('fires _reconcileOnStartup() as a background Promise without blocking constructor', () => {
    // The constructor must return synchronously — void reconcile is fire-and-forget
    const start = Date.now();
    makeClient();
    expect(Date.now() - start).toBeLessThan(50);
  });
});

// ─── §2 — guard() registration ───────────────────────────────────────────────

describe('MeshgateClient — guard() registration', () => {
  it('returns a callable function', () => {
    const client = makeClient();
    const wrapped = client.guard(async (x: number) => x * 2, { intent: 'double' });
    expect(typeof wrapped).toBe('function');
  });

  it('throws MeshgateConfigError on duplicate intent', () => {
    const client = makeClient();
    client.guard(async () => 'first', { intent: 'my_intent' });
    expect(() => client.guard(async () => 'second', { intent: 'my_intent' })).toThrow(
      MeshgateConfigError,
    );
  });

  it('allows different intents on the same client', () => {
    const client = makeClient();
    expect(() => {
      client.guard(async () => 'a', { intent: 'intent_a' });
      client.guard(async () => 'b', { intent: 'intent_b' });
    }).not.toThrow();
  });
});

// ─── §3 — guard() allowed flow (HTTP 200) ───────────────────────────────────

describe('MeshgateClient — guard() allowed (200)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('calls fn() immediately and returns its result', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeAllowedRes());
    const client = makeClient();
    const fn = vi.fn().mockResolvedValue(42);
    const wrapped = client.guard(fn, { intent: 'calc' });

    const result = await wrapped(1, 2);
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith(1, 2);
  });

  it('does not write to adapter when allowed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeAllowedRes());
    const adapter = new NoopAdapter();
    const setSpy = vi.spyOn(adapter, 'set');
    const client = makeClient({ storageAdapter: adapter });
    const wrapped = client.guard(async () => 'ok', { intent: 'noop' });

    await wrapped();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('passes intentArgs derived from getIntentArgs to the API', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeAllowedRes());
    const client = makeClient();
    const wrapped = client.guard(async (x: number) => x, {
      intent: 'multiply',
      getIntentArgs: (x) => ({ x }),
    });

    await wrapped(5);
    const call = fetchSpy.mock.calls[0];
    const body = JSON.parse((call?.[1])?.body as string) as Record<string, unknown>;
    expect(body['intentArgs']).toEqual({ x: 5 });
  });
});

// ─── §4 — guard() blocked flow (HTTP 403) ────────────────────────────────────

describe('MeshgateClient — guard() blocked (403)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('throws MeshgateBlockedError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeBlockedRes());
    const client = makeClient();
    const fn = vi.fn();
    const wrapped = client.guard(fn, { intent: 'blocked_action' });

    await expect(wrapped()).rejects.toBeInstanceOf(MeshgateBlockedError);
    expect(fn).not.toHaveBeenCalled();
  });
});

// ─── §5 — guard() gated flow (HTTP 201) ──────────────────────────────────────

describe('MeshgateClient — guard() gated (201)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes StoredGateRecord to adapter on 201', async () => {
    const approvalId = 'appr_gate_001';
    const adapter = new NoopAdapter();
    const setSpy = vi.spyOn(adapter, 'set');

    setupGatedFlowMocks(approvalId, 'tok_abc', makeSseApprovalStream(approvalId, 'tok_abc'));

    const client = makeClient({ storageAdapter: adapter });
    const fn = vi.fn().mockResolvedValue('done');
    const wrapped = client.guard(fn, { intent: 'gated_action' });

    await wrapped('arg1');

    expect(setSpy).toHaveBeenCalledOnce();
    const [savedId, savedJson] = setSpy.mock.calls[0] as unknown as [string, string];
    expect(savedId).toBe(approvalId);
    const record = JSON.parse(savedJson) as StoredGateRecord;
    expect(record.schemaVersion).toBe('1');
    expect(record.approvalId).toBe(approvalId);
    expect(record.intent).toBe('gated_action');
    expect(typeof record.iv).toBe('string');
    expect(typeof record.ciphertext).toBe('string');
    // gateNonce must NOT be stored locally (split-knowledge invariant)
    expect(Object.keys(record)).not.toContain('gateNonce');
  });

  it('calls fn() after approval with decrypted args', async () => {
    const approvalId = 'appr_gate_002';
    const fn = vi.fn().mockResolvedValue('result');

    // setupGatedFlowMocks captures the gateNonce from the intent request so
    // AES-GCM decryption succeeds with the right key.
    setupGatedFlowMocks(approvalId, 'tok_xyz', makeSseApprovalStream(approvalId, 'tok_xyz'));

    const client = makeClient();
    const wrapped = client.guard(fn, { intent: 'fn_call_test' });

    const result = await wrapped('hello', 42);
    expect(result).toBe('result');
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith('hello', 42);
  });

  it('deletes adapter record after successful execution', async () => {
    const approvalId = 'appr_gate_003';
    const adapter = new NoopAdapter();
    const deleteSpy = vi.spyOn(adapter, 'delete');

    setupGatedFlowMocks(approvalId, 'tok_del', makeSseApprovalStream(approvalId, 'tok_del'));

    const client = makeClient({ storageAdapter: adapter });
    const wrapped = client.guard(async () => 'ok', { intent: 'delete_test' });

    await wrapped();
    expect(deleteSpy).toHaveBeenCalledWith(approvalId);
  });

  it('fires onGateRejected hook and throws MeshgateRejectedError on rejection', async () => {
    const approvalId = 'appr_rejected';
    const onGateRejected = vi.fn();

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeGatedRes(approvalId))
      .mockResolvedValueOnce(makeSseRejectedStream(approvalId));

    const client = makeClient({ hooks: { onGateRejected } });
    const fn = vi.fn();
    const wrapped = client.guard(fn, { intent: 'reject_test' });

    await expect(wrapped()).rejects.toBeInstanceOf(MeshgateRejectedError);
    expect(fn).not.toHaveBeenCalled();
    expect(onGateRejected).toHaveBeenCalledOnce();
    const hookArg = onGateRejected.mock.calls[0][0] as GateInfo;
    expect(hookArg.approvalId).toBe(approvalId);
  });

  it('fires onGateExpired hook and throws MeshgateExpiredError on expiry', async () => {
    const approvalId = 'appr_expired';
    const onGateExpired = vi.fn();

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeGatedRes(approvalId))
      .mockResolvedValueOnce(makeSseExpiredStream(approvalId));

    const client = makeClient({ hooks: { onGateExpired } });
    const fn = vi.fn();
    const wrapped = client.guard(fn, { intent: 'expire_test' });

    await expect(wrapped()).rejects.toBeInstanceOf(MeshgateExpiredError);
    expect(fn).not.toHaveBeenCalled();
    expect(onGateExpired).toHaveBeenCalledOnce();
  });

  it('throws MeshgateTamperError when payloadHash mismatches', async () => {
    const approvalId = 'appr_tamper';
    let capturedGateNonce: string | null = null;

    // Use correct gateNonce so decryption succeeds, but return a wrong payloadHash
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.endsWith('/v1/intent')) {
        const body = JSON.parse((init?.body as string) ?? '{}') as { gateNonce?: string };
        capturedGateNonce = body.gateNonce ?? null;
        return makeGatedRes(approvalId);
      }
      if (url.includes('/v1/events/stream')) return makeSseApprovalStream(approvalId, 'tok_tamper');
      if (url.endsWith('/v1/verify-token')) return makeVerifyRes(approvalId, 'WRONGHASH==', capturedGateNonce);
      throw new Error(`Unexpected: ${url}`);
    });

    const client = makeClient();
    const wrapped = client.guard(async (x: string) => x, { intent: 'tamper_test' });

    await expect(wrapped('arg')).rejects.toBeInstanceOf(MeshgateTamperError);
  });

  it('throws MeshgateOrphanedError when verify-token returns 403 token_exhausted', async () => {
    const approvalId = 'appr_orphan';
    const onGateOrphaned = vi.fn();

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeGatedRes(approvalId))
      .mockResolvedValueOnce(makeSseApprovalStream(approvalId, 'tok_burned'))
      .mockResolvedValueOnce(makeJsonRes(403, { error: 'token_exhausted' }));

    const client = makeClient({ hooks: { onGateOrphaned } });
    const wrapped = client.guard(async () => 'ok', { intent: 'orphan_test' });

    await expect(wrapped()).rejects.toBeInstanceOf(MeshgateOrphanedError);
    expect(onGateOrphaned).toHaveBeenCalledOnce();
  });
});

// ─── §6 — guard() serialization validation ───────────────────────────────────

describe('MeshgateClient — guard() serialization', () => {
  afterEach(() => vi.restoreAllMocks());

  it('throws MeshgateSerializationError before any network call for Date args', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const client = makeClient();
    const wrapped = client.guard(async (d: Date) => d.toISOString(), { intent: 'date_test' });

    await expect(wrapped(new Date())).rejects.toBeInstanceOf(MeshgateSerializationError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws MeshgateSerializationError for function args', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const client = makeClient();
    const wrapped = client.guard(async (fn: () => void) => fn(), {
      intent: 'fn_test',
    });

    await expect(wrapped(() => undefined)).rejects.toBeInstanceOf(MeshgateSerializationError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws MeshgateSerializationError for symbol args', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const client = makeClient();
    // Use type cast to bypass TypeScript's type check for the test
    const wrapped = client.guard(async (x: unknown) => x, { intent: 'sym_test' });

    await expect(wrapped(Symbol('test'))).rejects.toBeInstanceOf(MeshgateSerializationError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws MeshgateSerializationError for nested intentArgs', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const client = makeClient();
    const wrapped = client.guard(async (x: number) => x, {
      intent: 'flat_test',
      getIntentArgs: (x) => ({ x, nested: { bad: true } } as unknown as Record<string, string | number | boolean>),
    });

    await expect(wrapped(1)).rejects.toBeInstanceOf(MeshgateSerializationError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not throw for plain-object args', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeAllowedRes());
    const client = makeClient();
    const wrapped = client.guard(async (obj: Record<string, unknown>) => obj, {
      intent: 'obj_test',
    });

    await expect(wrapped({ a: 1, b: 'hello', c: true })).resolves.not.toThrow();
  });
});

// ─── §7 — validateSerializable (unit) ────────────────────────────────────────

describe('validateSerializable', () => {
  it('does not throw for strings, numbers, booleans, null, plain objects, arrays', () => {
    expect(() => validateSerializable(['hello', 1, true, null, { a: 1 }, [1, 2]], 'test')).not.toThrow();
  });

  it('throws for Date', () => {
    expect(() => validateSerializable([new Date()], 'test')).toThrow(MeshgateSerializationError);
  });

  it('throws for function', () => {
    expect(() => validateSerializable([() => undefined], 'test')).toThrow(MeshgateSerializationError);
  });

  it('throws for symbol', () => {
    expect(() => validateSerializable([Symbol('x')], 'test')).toThrow(MeshgateSerializationError);
  });

  it('throws for bigint', () => {
    expect(() => validateSerializable([BigInt(1)], 'test')).toThrow(MeshgateSerializationError);
  });

  it('throws for class instance', () => {
    class Foo {}
    expect(() => validateSerializable([new Foo()], 'test')).toThrow(MeshgateSerializationError);
  });

  it('throws for nested Date inside an object', () => {
    expect(() => validateSerializable([{ date: new Date() }], 'test')).toThrow(
      MeshgateSerializationError,
    );
  });

  it('throws for circular reference', () => {
    const obj: Record<string, unknown> = {};
    obj['self'] = obj;
    expect(() => validateSerializable([obj], 'test')).toThrow(MeshgateSerializationError);
  });
});

// ─── §8 — validateIntentArgsFlatness (unit) ──────────────────────────────────

describe('validateIntentArgsFlatness', () => {
  it('does not throw for flat string/number/boolean values', () => {
    expect(() =>
      validateIntentArgsFlatness({ a: 'hello', b: 42, c: true }, 'test'),
    ).not.toThrow();
  });

  it('throws for null value', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => validateIntentArgsFlatness({ x: null as any }, 'test')).toThrow(
      MeshgateSerializationError,
    );
  });

  it('throws for nested object', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => validateIntentArgsFlatness({ x: { nested: 1 } as any }, 'test')).toThrow(
      MeshgateSerializationError,
    );
  });

  it('throws for array', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => validateIntentArgsFlatness({ x: [1, 2] as any }, 'test')).toThrow(
      MeshgateSerializationError,
    );
  });
});

// ─── §9 — startup reconcile (_reconcile) ────────────────────────────────────

describe('MeshgateClient — startup reconcile', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns all-empty result when adapter has no keys', async () => {
    const client = makeClient({ storageAdapter: new NoopAdapter() });
    const result = await reconcile(client);
    expect(result).toEqual({
      resumed: [],
      rejected: [],
      expired: [],
      orphaned: [],
      pending: [],
    });
  });

  it('puts locally expired gate in expired list and fires onGateExpired', async () => {
    const approvalId = 'rec_expired';
    const pastDate = new Date(Date.now() - 1000).toISOString();
    const record: StoredGateRecord = {
      schemaVersion: '1',
      approvalId,
      intent: 'some_intent',
      expiresAt: pastDate,
      iv: 'AAAA',
      authTag: 'BBBB',
      ciphertext: 'CCCC',
    };

    const deleteMock = vi.fn().mockResolvedValue(undefined);
    const adapter: MeshgateStorageAdapter = {
      listKeys: async () => [approvalId],
      get: async () => JSON.stringify(record),
      set: async () => undefined,
      delete: deleteMock,
    };

    const onGateExpired = vi.fn();
    const client = makeClient({ storageAdapter: adapter, hooks: { onGateExpired } });

    const result = await reconcile(client);
    expect(result.expired).toHaveLength(1);
    expect(result.expired[0]?.approvalId).toBe(approvalId);
    expect(onGateExpired).toHaveBeenCalledOnce();
    expect(deleteMock).toHaveBeenCalledWith(approvalId);
  });

  it('puts rejected cloud-status gate in rejected list and fires onGateRejected', async () => {
    const approvalId = 'rec_rejected';
    const futureDate = new Date(Date.now() + 86400_000).toISOString();
    const record: StoredGateRecord = {
      schemaVersion: '1',
      approvalId,
      intent: 'some_intent',
      expiresAt: futureDate,
      iv: 'AAAA',
      authTag: 'BBBB',
      ciphertext: 'CCCC',
    };

    const adapter: MeshgateStorageAdapter = {
      listKeys: async () => [approvalId],
      get: async () => JSON.stringify(record),
      set: async () => undefined,
      delete: vi.fn().mockResolvedValue(undefined),
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonRes(200, {
        id: approvalId,
        status: 'rejected',
        resolvedAt: '2099-01-01T00:00:00Z',
        token: null,
        gateNonce: null,
      }),
    );

    const onGateRejected = vi.fn();
    const client = makeClient({ storageAdapter: adapter, hooks: { onGateRejected } });

    const result = await reconcile(client);
    expect(result.rejected).toHaveLength(1);
    expect(onGateRejected).toHaveBeenCalledOnce();
  });

  it('puts 404 gate in orphaned list and fires onGateOrphaned', async () => {
    const approvalId = 'rec_404';
    const futureDate = new Date(Date.now() + 86400_000).toISOString();
    const record: StoredGateRecord = {
      schemaVersion: '1',
      approvalId,
      intent: 'some_intent',
      expiresAt: futureDate,
      iv: 'AAAA',
      authTag: 'BBBB',
      ciphertext: 'CCCC',
    };

    const adapter: MeshgateStorageAdapter = {
      listKeys: async () => [approvalId],
      get: async () => JSON.stringify(record),
      set: async () => undefined,
      delete: vi.fn().mockResolvedValue(undefined),
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonRes(404, { error: 'not_found' }),
    );

    const onGateOrphaned = vi.fn();
    const client = makeClient({ storageAdapter: adapter, hooks: { onGateOrphaned } });

    const result = await reconcile(client);
    expect(result.orphaned).toHaveLength(1);
    expect(onGateOrphaned).toHaveBeenCalledOnce();
  });

  it('puts gate with no registered handler in orphaned list', async () => {
    const approvalId = 'rec_no_handler';
    const futureDate = new Date(Date.now() + 86400_000).toISOString();
    const record: StoredGateRecord = {
      schemaVersion: '1',
      approvalId,
      intent: 'unregistered_intent',
      expiresAt: futureDate,
      iv: 'AAAA',
      authTag: 'BBBB',
      ciphertext: 'CCCC',
    };

    const adapter: MeshgateStorageAdapter = {
      listKeys: async () => [approvalId],
      get: async () => JSON.stringify(record),
      set: async () => undefined,
      delete: vi.fn().mockResolvedValue(undefined),
    };

    // Status = approved with token, but verify-token will need a real gateNonce
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        makeJsonRes(200, {
          id: approvalId,
          status: 'approved',
          resolvedAt: '2099-01-01T00:00:00Z',
          token: 'tok_handler_missing',
          gateNonce: null,
        }),
      )
      .mockResolvedValueOnce(makeVerifyRes(approvalId, null)); // verify-token returns without gateNonce

    const onGateOrphaned = vi.fn();
    const client = makeClient({ storageAdapter: adapter, hooks: { onGateOrphaned } });
    // No guard() registered for 'unregistered_intent'

    const result = await reconcile(client);
    expect(result.orphaned).toHaveLength(1);
    expect(onGateOrphaned).toHaveBeenCalledOnce();
  });

  it('re-subscribes SSE for pending gates and adds to pending list', async () => {
    const approvalId = 'rec_pending';
    const futureDate = new Date(Date.now() + 86400_000).toISOString();
    const record: StoredGateRecord = {
      schemaVersion: '1',
      approvalId,
      intent: 'pending_intent',
      expiresAt: futureDate,
      iv: 'AAAA',
      authTag: 'BBBB',
      ciphertext: 'CCCC',
    };

    const adapter: MeshgateStorageAdapter = {
      listKeys: async () => [approvalId],
      get: async () => JSON.stringify(record),
      set: async () => undefined,
      delete: vi.fn().mockResolvedValue(undefined),
    };

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        makeJsonRes(200, {
          id: approvalId,
          status: 'pending',
          resolvedAt: null,
          token: null,
          gateNonce: null,
        }),
      )
      // SSE connection (stays open / returns empty to avoid reconnect loops)
      .mockResolvedValueOnce(
        new Response(new ReadableStream({ start(c) { c.close(); } }), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );

    const client = makeClient({ storageAdapter: adapter });
    client.guard(async () => 'from_sse', { intent: 'pending_intent' });

    const result = await reconcile(client);
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]?.approvalId).toBe(approvalId);
  });

  it('is idempotent — calling twice on empty adapter returns empty both times', async () => {
    const client = makeClient();
    const r1 = await reconcile(client);
    const r2 = await reconcile(client);
    expect(r1).toEqual(r2);
  });
});

// ─── §10 — @guardrail decorator ──────────────────────────────────────────────

describe('@guardrail decorator', () => {
  afterEach(() => vi.restoreAllMocks());

  it('wraps a class method and calls it with correct args on allowed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeAllowedRes());

    const client = makeClient();
    const fnSpy = vi.fn().mockResolvedValue('decorated result');

    class TestService {
      @guardrail(client, { intent: 'decorator_test' })
      async doWork(x: number): Promise<string> {
        return fnSpy(x) as Promise<string>;
      }
    }

    const svc = new TestService();
    const result = await svc.doWork(99);

    expect(result).toBe('decorated result');
    expect(fnSpy).toHaveBeenCalledWith(99);
  });

  it('throws MeshgateBlockedError when policy blocks', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeBlockedRes());

    const client = makeClient();

    class BlockedService {
      @guardrail(client, { intent: 'blocked_decorator' })
      async act(): Promise<void> {
        // never called
      }
    }

    const svc = new BlockedService();
    await expect(svc.act()).rejects.toBeInstanceOf(MeshgateBlockedError);
  });

  it('throws MeshgateConfigError on duplicate intent across decorator and guard()', () => {
    const client = makeClient();
    client.guard(async () => 'first', { intent: 'shared_intent' });

    expect(() => {
      class DupService {
        @guardrail(client, { intent: 'shared_intent' })
        async act(): Promise<void> {/* */}
      }
      void DupService;
    }).toThrow(MeshgateConfigError);
  });
});

// ─── §11 — Lifecycle hooks wired into guard() ────────────────────────────────

describe('Lifecycle hooks — onGateOrphaned via guard()', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fires onGateOrphaned when verify-token returns 403 token_exhausted', async () => {
    const approvalId = 'appr_hook_orphan';
    const onGateOrphaned = vi.fn();

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeGatedRes(approvalId))
      .mockResolvedValueOnce(makeSseApprovalStream(approvalId, 'tok_stale'))
      .mockResolvedValueOnce(makeJsonRes(403, { error: 'token_exhausted' }));

    const client = makeClient({ hooks: { onGateOrphaned } });
    const wrapped = client.guard(async () => 'ok', { intent: 'orphan_hook' });

    await expect(wrapped()).rejects.toBeInstanceOf(MeshgateOrphanedError);
    expect(onGateOrphaned).toHaveBeenCalledOnce();
    const info = onGateOrphaned.mock.calls[0][0] as GateInfo;
    expect(info.intent).toBe('orphan_hook');
    expect(info.approvalId).toBe(approvalId);
  });
});
