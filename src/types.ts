/**
 * Core TypeScript interfaces for @meshgate/sdk.
 *
 * All interfaces in this file are the stable public contract for v2.2.
 * Do not change field names or types without a semver major bump.
 */

import type { MeshgateStorageAdapter } from './adapters/types.js';

// ─── Stored Gate State ──────────────────────────────────────────────────────

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
export interface StoredGateRecord {
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
}

/**
 * The plaintext payload that is AES-256-GCM encrypted and stored in
 * `StoredGateRecord.ciphertext`. Never written to storage in plaintext.
 */
export interface GatePayload {
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

// ─── Client Configuration ────────────────────────────────────────────────────

/**
 * Lifecycle hook called when a gate reaches a terminal state without
 * executing the wrapped function.
 */
export type GateLifecycleHook = (gate: GateInfo) => void | Promise<void>;

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
export interface MeshgateConfig {
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
     * Called when a gate's token has already been burned (consumed by another
     * process), or when the approval record cannot be found.
     */
    onGateOrphaned?: GateLifecycleHook;
    /**
     * Called after a gate is approved, verified, decrypted, and the wrapped
     * function has been executed. Fired by reconcile() when a previously
     * pending gate is resumed on startup.
     */
    onGateApproved?: GateLifecycleHook;
  };

  /**
   * Emit structured debug logs to `console.log`.
   * Logs only structural metadata (intent name, approvalId, event type).
   * NEVER logs args, payloadHash, gateNonce, iv, ciphertext, apiKey, or
   * localEncryptionKey.
   * @default false
   */
  debug?: boolean;
}

// ─── guard() Options ─────────────────────────────────────────────────────────

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
export interface GuardOptions<TArgs extends unknown[]> {
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

// ─── Gate Info ───────────────────────────────────────────────────────────────

/**
 * Metadata about a gate, passed to lifecycle hooks and included in
 * `ReconcileResult` arrays.
 */
export interface GateInfo {
  /** The Meshgate cloud approval ID for this gate. */
  approvalId: string;
  /** The intent name this gate was registered under. */
  intent: string;
  /** ISO-8601 expiry timestamp. */
  expiresAt: string;
}

// ─── reconcile() Result ───────────────────────────────────────────────────────

/**
 * The result returned by the internal startup reconcile scan after processing
 * all pending gates in the storage adapter.
 *
 * All arrays contain `GateInfo` objects for the corresponding terminal state.
 * An empty array means no gates reached that state during this reconcile run.
 */
export interface ReconcileResult {
  /**
   * Gates that were approved, verified, executed, and cleaned up.
   * The registered handler was called for each of these gates.
   */
  resumed: GateInfo[];

  /**
   * Gates that were rejected by a human approver.
   * `onGateRejected` hook was fired for each.
   */
  rejected: GateInfo[];

  /**
   * Gates that expired before approval.
   * `onGateExpired` hook was fired for each.
   */
  expired: GateInfo[];

  /**
   * Gates whose token was already burned (consumed by another process), whose
   * approval record was not found in the cloud, or whose registered handler
   * could not be found by intent name.
   * `onGateOrphaned` hook was fired for each.
   */
  orphaned: GateInfo[];

  /**
   * Gates still pending approval. SSE re-subscription was initiated for each.
   * These gates remain in the adapter until resolved or expired.
   */
  pending: GateInfo[];
}
