/**
 * Storage adapter interface for @meshgate/sdk.
 *
 * Implement this interface to provide custom gate state persistence.
 * Two built-in adapters ship with the SDK:
 *   - `FileSystemAdapter` — Node.js, stores `.meshgate/{approvalId}.json`
 *   - `CloudflareKVAdapter` — Cloudflare Workers, uses KV binding
 *
 * A `NoopAdapter` is also provided for environments where persistence is
 * handled externally or explicitly disabled.
 */
interface MeshgateStorageAdapter {
    /**
     * Persist encrypted gate state keyed by `approvalId`.
     * Called once per gate after a successful `POST /v1/intent` → 201 response.
     * The `data` value is always ciphertext — this adapter never handles plaintext.
     */
    set(approvalId: string, data: string): Promise<void>;
    /**
     * Retrieve encrypted gate state by `approvalId`.
     * Returns `null` if the key does not exist (gate was cleaned up or never created).
     */
    get(approvalId: string): Promise<string | null>;
    /**
     * Delete gate state after the gate resolves (approved + executed, rejected,
     * expired, or orphaned). Must be idempotent — deleting a non-existent key
     * must not throw.
     */
    delete(approvalId: string): Promise<void>;
    /**
     * List all stored `approvalId` values.
     * Used by `reconcile()` on startup to discover pending gates.
     * Returns an empty array if no gates are currently stored.
     */
    listKeys(): Promise<string[]>;
}

/**
 * Core TypeScript interfaces for @meshgate/sdk.
 *
 * All interfaces in this file are the stable public contract for v2.2.
 * Do not change field names or types without a semver major bump.
 */

/**
 * The record written to the storage adapter for each pending gate.
 *
 * `approvalId`, `intent`, and `expiresAt` are stored in plaintext so that
 * `reconcile()` can scan and route without decryption. Everything sensitive
 * (function arguments) lives in `ciphertext`.
 *
 * INVARIANT: `gateNonce` is NOT a field of this record. It is held by the
 * Meshgate cloud and returned only on a successful `POST /v1/verify-token`.
 * This is the split-knowledge security property: local storage has ciphertext
 * (no nonce); cloud has nonce (no master secret). Both are required to decrypt.
 */
interface StoredGateRecord {
    /** Schema version — always '1' for v2.2 records. */
    schemaVersion: '1';
    /** Meshgate cloud approval ID — also the storage key in the adapter. */
    approvalId: string;
    /** Intent name, in plaintext — used by reconcile() to route to the handler. */
    intent: string;
    /** ISO-8601 expiry timestamp — used for local expiry check without decryption. */
    expiresAt: string;
    /** Base64-encoded AES-256-GCM initialization vector (12 bytes). */
    iv: string;
    /** Base64-encoded AES-256-GCM authentication tag (16 bytes). */
    authTag: string;
    /** Base64-encoded AES-256-GCM ciphertext of the serialized GatePayload. */
    ciphertext: string;
    /**
     * Unix ms timestamp of when this gate was created. Written by the SDK at
     * gate registration time. Used by reconcile() to sort pending gates FIFO.
     * Optional for backwards-compat with records written before v2.3.
     */
    createdAt?: number;
}
/**
 * The plaintext payload that is AES-256-GCM encrypted and stored in
 * `StoredGateRecord.ciphertext`. Never written to storage in plaintext.
 */
interface GatePayload {
    /** Schema version — always '1' for v2.2 payloads. */
    schemaVersion: '1';
    /**
     * The original function arguments passed to the wrapped function.
     * All values must be JSON-serializable (strings, numbers, booleans,
     * plain objects, arrays, null). Non-serializable values throw
     * `MeshgateSerializationError` before encryption.
     */
    args: unknown[];
}
/**
 * Lifecycle hook called when a gate reaches a terminal state without
 * executing the wrapped function.
 */
type GateLifecycleHook = (gate: GateInfo) => void | Promise<void>;
/**
 * Specific reason codes for gate orphaning. Passed to `onGateOrphaned`.
 *
 * - `token_exhausted_on_retry`: The SDK burned the token server-side but lost
 *   the 200 response (network drop). A subsequent retry got 403 token_exhausted.
 *   This SDK instance had the in-flight call when the 403 arrived.
 * - `token_already_used`: The server returned 403 token_exhausted but this SDK
 *   instance had no prior in-flight call for this gate. Another process likely
 *   consumed the token.
 * - `gate_not_found`: The approval record was not found in the cloud (404) or
 *   the intent handler was removed between deploys.
 * - `decryption_failed`: AES-256-GCM decryption failed during reconcile. Most
 *   likely cause: MESHGATE_LOCAL_SECRET was rotated between gate creation and
 *   reconcile. The wrapped function is NOT called.
 * - `verify_failed`: A catch-all for unexpected terminal conditions during
 *   reconcile or the live guard flow.
 */
type GateOrphanedReason = 'token_exhausted_on_retry' | 'token_already_used' | 'gate_not_found' | 'decryption_failed' | 'verify_failed';
/**
 * Event passed to the `onGateOrphaned` lifecycle hook.
 *
 * This is a type alias for `GateInfo` — the `reason` and `message` fields
 * defined on `GateInfo` are always populated when a gate info object is passed
 * to `onGateOrphaned`. Using a type alias (rather than a separate interface)
 * preserves backward compatibility: existing consumers that access `.approvalId`,
 * `.intent`, or `.expiresAt` continue to work without any changes.
 */
type GateOrphanedEvent = GateInfo;
/**
 * Configuration for `MeshgateClient`.
 *
 * @example
 * ```typescript
 * const client = new MeshgateClient({
 *   apiKey: process.env.MESHGATE_API_KEY!,
 *   localEncryptionKey: process.env.MESHGATE_LOCAL_SECRET!,
 * });
 * ```
 */
interface MeshgateConfig {
    /**
     * Agent API key. Must start with `mg_live_` or `mg_test_`.
     * Required — constructor throws `MeshgateConfigError` if missing or empty.
     * Requires `sdk:write` scope for POST /v1/intent and
     * `sdk:read` scope for status, verify-token, and SSE.
     */
    apiKey: string;
    /**
     * Master secret used as IKM for HKDF key derivation. Must be ≥ 32 characters.
     * Never sent to the Meshgate cloud. Never logged or included in error messages.
     * Required — constructor throws `MeshgateConfigError` if shorter than 32 chars.
     *
     * Generate with: `openssl rand -hex 32`
     */
    localEncryptionKey: string;
    /**
     * Meshgate cloud base URL.
     * @default 'https://api.meshgate.dev'
     */
    baseUrl?: string;
    /**
     * Storage adapter for persisting pending gate state across process restarts.
     *
     * - In Node.js environments: defaults to `FileSystemAdapter` (stores in `.meshgate/`)
     * - In Cloudflare Workers / edge: you MUST provide `CloudflareKVAdapter` explicitly
     * - To opt out of persistence (loses cold-resume): provide `NoopAdapter` explicitly
     *
     * If omitted and `node:fs` is not available, the constructor throws
     * `MeshgateConfigError` advising to provide `CloudflareKVAdapter`.
     */
    storageAdapter?: MeshgateStorageAdapter;
    /**
     * Lifecycle hooks called when gates reach terminal states without execution.
     * All hooks are optional. Async hooks are awaited before continuing.
     */
    hooks?: {
        /** Called when a gate expires before the approver acts. */
        onGateExpired?: GateLifecycleHook;
        /** Called when a human rejects an approval. */
        onGateRejected?: GateLifecycleHook;
        /**
         * Called when a gate is orphaned. Receives a `GateInfo` (aliased as
         * `GateOrphanedEvent`) with the `reason` and `message` fields populated.
         *
         * Because `GateOrphanedEvent` is a type alias for `GateInfo`, existing
         * callbacks that accept `GateInfo` continue to work without modification.
         *
         * Reasons: `token_exhausted_on_retry`, `token_already_used`,
         * `gate_not_found`, `decryption_failed`, `verify_failed`.
         */
        onGateOrphaned?: (event: GateOrphanedEvent) => void | Promise<void>;
        /**
         * Called after a gate is approved, verified, decrypted, and the wrapped
         * function has been executed. Fired by reconcile() when a previously
         * pending gate is resumed on startup.
         */
        onGateApproved?: GateLifecycleHook;
    };
    /**
     * Reconnect delay schedule (ms) for the SSE client.
     * After all delays are exhausted, the SDK falls back to polling.
     * Pass `[0, 0, 0]` in tests for instant reconnect behaviour.
     * @default [0, 1000, 2000]
     */
    sseReconnectDelays?: number[];
    /**
     * Minimum severity of internal SDK log messages emitted to `console`.
     * Logs only structural metadata (intent name, approvalId, event type).
     * NEVER logs args, payloadHash, gateNonce, iv, ciphertext, apiKey, or
     * localEncryptionKey.
     * @default 'info'
     */
    logLevel?: 'debug' | 'info' | 'warn' | 'error';
    /**
     * @deprecated Use `logLevel: 'debug'` instead.
     * Kept for backwards compatibility — `debug: true` maps to `logLevel: 'debug'`.
     */
    debug?: boolean;
}
/**
 * Options for `client.guard()`.
 *
 * @typeParam TArgs - Tuple type matching the wrapped function's argument list.
 *
 * @example
 * ```typescript
 * const gatedRefund = client.guard(processRefund, {
 *   intent: 'process_refund',
 *   getIntentArgs: (_, amount) => ({ amount }),
 *   description: 'Process customer refund',
 * });
 * ```
 */
interface GuardOptions<TArgs extends unknown[]> {
    /**
     * Intent name sent to the Meshgate cloud for policy evaluation.
     *
     * Must be unique within this `MeshgateClient` instance — calling `guard()`
     * twice with the same intent throws `MeshgateConfigError`.
     *
     * This name is also used as the handler routing key in `reconcile()` on
     * process restart. If the intent name changes between deployments, any
     * pending gates for the old name will be orphaned.
     */
    intent: string;
    /**
     * Maps the wrapped function's arguments to a flat record of intent
     * arguments sent to the cloud for policy evaluation.
     *
     * The return value must be a **flat** record: every value must be
     * `string | number | boolean`. Nested objects, arrays, `null`, and
     * `undefined` throw `MeshgateSerializationError` (validated before any
     * network call).
     *
     * If omitted, no `intentArgs` are sent — policy evaluates intent name only.
     *
     * @example
     * ```typescript
     * getIntentArgs: (customerId, amount) => ({ customerId, amount })
     * ```
     */
    getIntentArgs?: (...args: TArgs) => Record<string, string | number | boolean>;
    /**
     * Gate expiry TTL in seconds. Valid range: 60–604800 (1 minute to 7 days).
     *
     * Overrides the tenant/agent/intent-level TTL from the v2.1 settings
     * hierarchy. If omitted, the cloud applies the most-specific configured TTL
     * (default: 72 hours = 259200 seconds).
     */
    expiresInSeconds?: number;
    /**
     * Human-readable description shown to the approver in the Meshgate dashboard.
     * Maximum 1000 characters. If omitted, only the intent name and intentArgs
     * are shown.
     */
    description?: string;
}
/**
 * Metadata about a gate, passed to lifecycle hooks and included in
 * `ReconcileResult` arrays.
 *
 * When passed to `onGateOrphaned`, the optional `reason` and `message` fields
 * are populated with the machine-readable reason code and human-readable
 * explanation for why the gate was orphaned.
 */
interface GateInfo {
    /** The Meshgate cloud approval ID for this gate. */
    approvalId: string;
    /** The intent name this gate was registered under. */
    intent: string;
    /** ISO-8601 expiry timestamp. */
    expiresAt: string;
    /**
     * Machine-readable reason code for why this gate was orphaned.
     * Only present when this `GateInfo` is passed to `onGateOrphaned`.
     */
    reason?: GateOrphanedReason;
    /**
     * Human-readable explanation for why this gate was orphaned.
     * Never contains secrets or sensitive args.
     * Only present when this `GateInfo` is passed to `onGateOrphaned`.
     */
    message?: string;
}

/**
 * MeshgateClient — the primary API surface for @meshgate/sdk.
 *
 * Reduces the full HITL workflow to a single `.guard()` call:
 * validate → register intent → encrypt → store → subscribe SSE →
 * verify-token (phone-home) → decrypt → tamper-check → execute fn().
 *
 * @example
 * ```typescript
 * const client = new MeshgateClient({
 *   apiKey: process.env.MESHGATE_API_KEY!,
 *   localEncryptionKey: process.env.MESHGATE_LOCAL_SECRET!,
 * });
 *
 * const gatedRefund = client.guard(processRefund, {
 *   intent: 'process_refund',
 *   getIntentArgs: (_, amount) => ({ amount }),
 * });
 *
 * const result = await gatedRefund('cust_123', 750);
 * ```
 */

declare class MeshgateClient {
    private readonly api;
    private readonly adapter;
    private readonly masterSecret;
    private readonly sseUrl;
    private readonly sseAuthHeader;
    private readonly hooks;
    private readonly logLevel;
    private readonly logger;
    private readonly sseReconnectDelays;
    /** intent name → registered handler, populated by guard(). */
    private readonly handlers;
    /** approvalId → pending entry, populated by guard() and reconcile(). */
    private readonly pendingGates;
    /** Shared SSE connection — started lazily on first gated response. */
    private sseClient;
    /**
     * Deduplication guard: if a reconcile is already in progress, return the
     * same Promise rather than starting a second concurrent scan. Cleared via
     * .finally() when the run completes or errors.
     */
    private reconcilePromise;
    /**
     * Resolves when the startup reconcile completes (or errors).
     * guard() awaits this before executing to ensure reconcile-registered
     * handlers are processed before new live calls proceed.
     */
    private readonly _reconcileReady;
    private _resolveReconcileReady;
    /**
     * Tracks verify-token calls that are currently in-flight (or were in-flight
     * when a non-fatal error occurred). Used to distinguish:
     * - `token_exhausted_on_retry`: this instance had an in-flight call when the
     *   403 arrived (server burned the token, response was lost, now retrying)
     * - `token_already_used`: no prior in-flight call — another process burned it
     */
    private readonly _pendingVerify;
    constructor(config: MeshgateConfig);
    /**
     * Wrap an async function with the Meshgate HITL gate.
     *
     * Returns a new function with the identical TypeScript signature as `fn`.
     * On each call, the returned function runs the full yield-and-hydrate flow:
     * POST /v1/intent → allowed (execute now) | blocked (throw) | gated (wait).
     *
     * @throws {MeshgateConfigError} if `options.intent` is already registered.
     */
    guard<TArgs extends unknown[], TReturn>(fn: (...args: TArgs) => Promise<TReturn>, options: GuardOptions<TArgs>): (...args: TArgs) => Promise<TReturn>;
    /**
     * Internal: scan the storage adapter for pending gates, resume approved ones,
     * clean up terminal states, and re-subscribe SSE for still-pending gates.
     *
     * Called automatically from the constructor. Deduplicates concurrent calls
     * by returning the in-progress Promise if one is already running.
     */
    private _reconcile;
    private _executeGuard;
    /**
     * Perform the mandatory phone-home verification, decrypt local state,
     * verify the payloadHash, and execute fn() with the decrypted args.
     *
     * This is called both from the live guard() flow and from reconcile().
     */
    private _verifyDecryptAndExecute;
    private _reconcileOnStartup;
    /**
     * Verify-token, decrypt, look up handler, and execute for a gate approved
     * during reconcile(). Returns true if the handler executed successfully.
     */
    private _reconcileApproved;
    /** Clean up a pending gate that reached a terminal state during reconcile. */
    private _reconcileTerminated;
    private ensureSseStarted;
    private handleSseEvent;
    private handleSseFallback;
    private pollGate;
    /** Stop SSE when there are no more pending gates. */
    private cleanupAfterGate;
    private fireHook;
    private fireOrphanedHook;
    private log;
}

export { type GuardOptions as G, MeshgateClient as M, type StoredGateRecord as S, type MeshgateStorageAdapter as a, type GateInfo as b, type GateLifecycleHook as c, type GateOrphanedEvent as d, type GateOrphanedReason as e, type GatePayload as f, type MeshgateConfig as g };
