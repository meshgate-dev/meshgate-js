import { a as MeshgateStorageAdapter } from './client-uGII_v8r.js';
export { b as GateInfo, c as GateLifecycleHook, d as GateOrphanedEvent, e as GateOrphanedReason, f as GatePayload, G as GuardOptions, M as MeshgateClient, g as MeshgateConfig, S as StoredGateRecord } from './client-uGII_v8r.js';

/**
 * A storage adapter that performs no I/O.
 *
 * **Use this only when you explicitly want to disable gate state persistence.**
 * With `NoopAdapter`, `reconcile()` always returns all-empty results and
 * cold resume after process restart is not available.
 *
 * Typical use cases:
 * - Automated tests that mock the full guard() flow
 * - Short-lived edge function invocations where state persistence is managed
 *   externally (e.g., you bring your own KV binding)
 *
 * To use, pass it explicitly in `MeshgateConfig.storageAdapter`:
 * ```typescript
 * const client = new MeshgateClient({
 *   apiKey: '...',
 *   localEncryptionKey: '...',
 *   storageAdapter: new NoopAdapter(),
 * });
 * ```
 *
 * @see CloudflareKVAdapter for Cloudflare Workers persistence
 * @see FileSystemAdapter for Node.js persistence (default)
 */
declare class NoopAdapter implements MeshgateStorageAdapter {
    set(): Promise<void>;
    get(): Promise<string | null>;
    delete(): Promise<void>;
    listKeys(): Promise<string[]>;
}

/**
 * FileSystemAdapter — Node.js storage adapter for @meshgate/sdk.
 *
 * Stores each gate's encrypted state as `.meshgate/{approvalId}.json`
 * relative to `baseDir` (defaults to `process.cwd()`).
 *
 * This adapter is NOT safe for use in Cloudflare Workers, Vercel Edge,
 * or Deno Deploy — use CloudflareKVAdapter or NoopAdapter in those
 * environments.
 *
 * Throws `MeshgateConfigError` if `node:fs/promises` is unavailable
 * (i.e., the runtime is not Node.js / Bun).
 */

declare class FileSystemAdapter implements MeshgateStorageAdapter {
    private readonly baseDir;
    private readonly dir;
    constructor(baseDir?: string);
    private keyPath;
    set(approvalId: string, data: string): Promise<void>;
    get(approvalId: string): Promise<string | null>;
    delete(approvalId: string): Promise<void>;
    listKeys(): Promise<string[]>;
}

/**
 * CloudflareKVAdapter — Cloudflare Workers KV storage adapter for @meshgate/sdk.
 *
 * Accepts any object that satisfies the `KVNamespaceLike` structural interface
 * (a subset of Cloudflare's `KVNamespace`). This avoids a hard dependency on
 * `@cloudflare/workers-types` while remaining fully type-compatible with it.
 *
 * Keys are prefixed with `mg:` to avoid collisions with other KV entries
 * in a shared namespace.
 *
 * Usage:
 * ```typescript
 * const client = new MeshgateClient({
 *   apiKey: env.MESHGATE_API_KEY,
 *   localEncryptionKey: env.MESHGATE_LOCAL_SECRET,
 *   storageAdapter: new CloudflareKVAdapter(env.MESHGATE_KV),
 * });
 * ```
 */

/**
 * Structural subset of Cloudflare's `KVNamespace` used by this adapter.
 * Compatible with `@cloudflare/workers-types` KVNamespace without a hard dependency.
 */
interface KVNamespaceLike {
    put(key: string, value: string): Promise<void>;
    get(key: string): Promise<string | null>;
    delete(key: string): Promise<void>;
    list(options?: {
        prefix?: string;
        cursor?: string;
    }): Promise<{
        keys: {
            name: string;
        }[];
        list_complete: boolean;
        cursor?: string;
    }>;
}
declare class CloudflareKVAdapter implements MeshgateStorageAdapter {
    private readonly kv;
    constructor(kv: KVNamespaceLike);
    private kvKey;
    set(approvalId: string, data: string): Promise<void>;
    get(approvalId: string): Promise<string | null>;
    delete(approvalId: string): Promise<void>;
    listKeys(): Promise<string[]>;
}

/**
 * All error classes for @meshgate/sdk.
 *
 * Every error thrown by the SDK is an instance of `MeshgateError`.
 * Subclasses represent distinct failure modes so callers can use
 * `catch (e) { if (e instanceof MeshgateBlockedError) ... }`.
 *
 * SECURITY: No error message, `intent` field, or `approvalId` field
 * ever contains secrets, keys, args, payloadHash, or ciphertext.
 */
/**
 * Base class for all Meshgate SDK errors.
 *
 * @example
 * ```typescript
 * try {
 *   await gatedRefund('cust_123', 750);
 * } catch (e) {
 *   if (e instanceof MeshgateBlockedError) {
 *     console.error('Refund blocked by policy', e.intent);
 *   } else if (e instanceof MeshgateExpiredError) {
 *     console.error('Approval window expired', e.approvalId);
 *   } else if (e instanceof MeshgateError) {
 *     console.error('Meshgate error', e.message);
 *   }
 * }
 * ```
 */
declare class MeshgateError extends Error {
    /** The intent name associated with the failed gate, if available. */
    readonly intent?: string;
    /** The Meshgate approval ID associated with the failed gate, if available. */
    readonly approvalId?: string;
    constructor(message: string, intent?: string, approvalId?: string);
}
/**
 * Thrown when the Meshgate cloud policy explicitly blocks the intent.
 * The wrapped function is NOT called.
 *
 * HTTP trigger: POST /v1/intent → 403 `intent_blocked`
 */
declare class MeshgateBlockedError extends MeshgateError {
}
/**
 * Thrown when a human approver rejects the approval in the dashboard.
 * The wrapped function is NOT called.
 *
 * Trigger: SSE `approval.rejected` event or GET /v1/approvals/:id/status → `rejected`
 */
declare class MeshgateRejectedError extends MeshgateError {
}
/**
 * Thrown when the approval window expires before a human acts.
 * The wrapped function is NOT called. Local gate state is deleted.
 *
 * Trigger: SSE `approval.expired` event, polling returns `expired`,
 * or local `expiresAt` check in `reconcile()`.
 */
declare class MeshgateExpiredError extends MeshgateError {
}
/**
 * Thrown when a gate's one-time token has already been burned (consumed
 * by another process or a prior `reconcile()` run), or when the approval
 * record no longer exists in the cloud.
 *
 * Also thrown in `reconcile()` when the intent handler for a pending gate
 * is not registered (renamed or removed between deploys).
 *
 * The wrapped function is NOT called.
 *
 * HTTP trigger: POST /v1/verify-token → 403 `token_exhausted` or 404
 */
declare class MeshgateOrphanedError extends MeshgateError {
    /** Machine-readable subcode indicating why the gate was orphaned. */
    readonly reason?: 'token_exhausted' | 'not_found';
    /**
     * @param message - Human-readable error message. Must not contain secrets.
     * @param intent - The intent name associated with the orphaned gate, if available.
     * @param approvalId - The Meshgate approval ID for the orphaned gate, if available.
     * @param reason - Machine-readable subcode for why this gate was orphaned:
     *   - `'token_exhausted'`: The one-time verify token was already consumed —
     *     either by another process or by a prior call in this process whose
     *     response was lost on the network. The SDK uses this to distinguish
     *     `token_exhausted_on_retry` vs `token_already_used` in `GateOrphanedReason`.
     *   - `'not_found'`: The approval record does not exist in the cloud (HTTP 404).
     *     This typically means the gate was already cleaned up or never registered.
     */
    constructor(message: string, intent?: string, approvalId?: string, reason?: 'token_exhausted' | 'not_found');
}
/**
 * Thrown when cryptographic tamper detection fires — either the AES-256-GCM
 * authentication tag fails (ciphertext was modified in storage) or the
 * `payloadHash` returned by `POST /v1/verify-token` does not match the
 * SDK's recomputed hash of the decrypted arguments.
 *
 * The wrapped function is NOT called. Execution is aborted immediately.
 * This is a security invariant: never execute with unverified arguments.
 */
declare class MeshgateTamperError extends MeshgateError {
}
/**
 * Thrown when the Meshgate cloud is unreachable after all retry attempts,
 * or when a network timeout occurs on a non-retryable call.
 *
 * The wrapped function is NOT called (fail-closed invariant).
 *
 * HTTP trigger: POST /v1/intent → 503 or timeout, exhausted after 3 retries
 */
declare class MeshgateNetworkError extends MeshgateError {
}
/**
 * Thrown for invalid SDK configuration detected at construction or call time.
 *
 * Examples:
 * - `apiKey` is missing or empty
 * - `localEncryptionKey` is shorter than 32 characters
 * - `guard()` called with a duplicate intent name on the same client instance
 * - `FileSystemAdapter` constructed in an environment without `node:fs`
 * - POST /v1/intent → 400 (agentId missing from API key metadata — SDK misconfiguration)
 */
declare class MeshgateConfigError extends MeshgateError {
}
/**
 * Thrown when function arguments cannot be serialized to JSON, or when
 * `getIntentArgs` returns a nested object (intentArgs must be flat).
 *
 * Thrown before any network calls or storage writes — no side effects occur.
 *
 * Examples:
 * - `Date` object in args
 * - Circular reference in args
 * - `getIntentArgs` returns `{ nested: { value: 1 } }` (not flat)
 */
declare class MeshgateSerializationError extends MeshgateError {
}
/**
 * Thrown when the Meshgate cloud returns 401 (invalid or expired API key),
 * or 403 `forbidden` (key exists but lacks required scope).
 *
 * HTTP trigger: any cloud endpoint → 401, or POST /v1/verify-token → 403 `forbidden`
 */
declare class MeshgateAuthError extends MeshgateError {
}

export { CloudflareKVAdapter, FileSystemAdapter, type KVNamespaceLike, MeshgateAuthError, MeshgateBlockedError, MeshgateConfigError, MeshgateError, MeshgateExpiredError, MeshgateNetworkError, MeshgateOrphanedError, MeshgateRejectedError, MeshgateSerializationError, MeshgateStorageAdapter, MeshgateTamperError, NoopAdapter };
