import type { MeshgateStorageAdapter } from './types.js';

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
export class NoopAdapter implements MeshgateStorageAdapter {
  set(): Promise<void> {
    return Promise.resolve();
  }

  get(): Promise<string | null> {
    return Promise.resolve(null);
  }

  delete(): Promise<void> {
    return Promise.resolve();
  }

  listKeys(): Promise<string[]> {
    return Promise.resolve([]);
  }
}
