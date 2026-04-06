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
export { FileSystemAdapter } from './adapters/fs-adapter.js';
export { CloudflareKVAdapter } from './adapters/kv-adapter.js';
export type { KVNamespaceLike } from './adapters/kv-adapter.js';

// ─── Core Types ──────────────────────────────────────────────────────────────
export type {
  StoredGateRecord,
  GatePayload,
  MeshgateConfig,
  GuardOptions,
  GateInfo,
  GateLifecycleHook,
  GateOrphanedEvent,
  GateOrphanedReason,
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
export { MeshgateClient } from './client.js';
