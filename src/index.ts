/**
 * @meshgate/sdk — main barrel export.
 *
 * @example
 * ```typescript
 * import { MeshgateClient, MeshgateBlockedError } from '@meshgate/sdk';
 *
 * const client = new MeshgateClient({
 *   apiKey: process.env.MESHGATE_API_KEY!,
 *   localEncryptionKey: process.env.MESHGATE_LOCAL_SECRET!,
 * });
 *
 * const gatedRefund = client.guard(processRefund, {
 *   intent: 'process_refund',
 *   getIntentArgs: (_, amount) => ({ amount }),
 * });
 * ```
 *
 * The `@guardrail` decorator is NOT exported here.
 * Import it separately: `import { guardrail } from '@meshgate/sdk/decorators'`
 */

// ─── Storage Adapters ────────────────────────────────────────────────────────
export type { MeshgateStorageAdapter } from './adapters/types.js';
export { NoopAdapter } from './adapters/noop-adapter.js';
// FileSystemAdapter and CloudflareKVAdapter — implemented in Phase 3 (MG22-005, MG22-006)

// ─── Core Types ──────────────────────────────────────────────────────────────
export type {
  StoredGateRecord,
  GatePayload,
  MeshgateConfig,
  GuardOptions,
  GateInfo,
  GateLifecycleHook,
  ReconcileResult,
} from './types.js';

// ─── Error Classes ───────────────────────────────────────────────────────────
export {
  MeshgateError,
  MeshgateBlockedError,
  MeshgateRejectedError,
  MeshgateExpiredError,
  MeshgateOrphanedError,
  MeshgateTamperError,
  MeshgateNetworkError,
  MeshgateConfigError,
  MeshgateSerializationError,
  MeshgateAuthError,
} from './errors.js';

// ─── MeshgateClient ──────────────────────────────────────────────────────────
// Implemented in Phase 3 (MG22-009)
// export { MeshgateClient } from './client.js';
