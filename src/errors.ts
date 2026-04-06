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
export class MeshgateError extends Error {
  /** The intent name associated with the failed gate, if available. */
  readonly intent?: string;
  /** The Meshgate approval ID associated with the failed gate, if available. */
  readonly approvalId?: string;

  constructor(message: string, intent?: string, approvalId?: string) {
    super(message);
    // Use new.target.name so subclasses get their own name without boilerplate.
    this.name = new.target.name;
    this.intent = intent;
    this.approvalId = approvalId;
    // Maintain correct instanceof checks when compiled to CommonJS.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the Meshgate cloud policy explicitly blocks the intent.
 * The wrapped function is NOT called.
 *
 * HTTP trigger: POST /v1/intent → 403 `intent_blocked`
 */
export class MeshgateBlockedError extends MeshgateError {}

/**
 * Thrown when a human approver rejects the approval in the dashboard.
 * The wrapped function is NOT called.
 *
 * Trigger: SSE `approval.rejected` event or GET /v1/approvals/:id/status → `rejected`
 */
export class MeshgateRejectedError extends MeshgateError {}

/**
 * Thrown when the approval window expires before a human acts.
 * The wrapped function is NOT called. Local gate state is deleted.
 *
 * Trigger: SSE `approval.expired` event, polling returns `expired`,
 * or local `expiresAt` check in `reconcile()`.
 */
export class MeshgateExpiredError extends MeshgateError {}

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
export class MeshgateOrphanedError extends MeshgateError {
  /** Machine-readable subcode indicating why the gate was orphaned. */
  readonly reason?: 'token_exhausted' | 'not_found';

  constructor(
    message: string,
    intent?: string,
    approvalId?: string,
    reason?: 'token_exhausted' | 'not_found',
  ) {
    super(message, intent, approvalId);
    this.reason = reason;
  }
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
export class MeshgateTamperError extends MeshgateError {}

/**
 * Thrown when the Meshgate cloud is unreachable after all retry attempts,
 * or when a network timeout occurs on a non-retryable call.
 *
 * The wrapped function is NOT called (fail-closed invariant).
 *
 * HTTP trigger: POST /v1/intent → 503 or timeout, exhausted after 3 retries
 */
export class MeshgateNetworkError extends MeshgateError {}

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
export class MeshgateConfigError extends MeshgateError {}

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
export class MeshgateSerializationError extends MeshgateError {}

/**
 * Thrown when the Meshgate cloud returns 401 (invalid or expired API key),
 * or 403 `forbidden` (key exists but lacks required scope).
 *
 * HTTP trigger: any cloud endpoint → 401, or POST /v1/verify-token → 403 `forbidden`
 */
export class MeshgateAuthError extends MeshgateError {}
