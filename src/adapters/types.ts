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
export interface MeshgateStorageAdapter {
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
