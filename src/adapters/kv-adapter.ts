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

import type { MeshgateStorageAdapter } from './types.js';

/**
 * Structural subset of Cloudflare's `KVNamespace` used by this adapter.
 * Compatible with `@cloudflare/workers-types` KVNamespace without a hard dependency.
 */
export interface KVNamespaceLike {
  put(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string }): Promise<{ keys: { name: string }[] }>;
}

const KEY_PREFIX = 'mg:';

export class CloudflareKVAdapter implements MeshgateStorageAdapter {
  private readonly kv: KVNamespaceLike;

  constructor(kv: KVNamespaceLike) {
    this.kv = kv;
  }

  private kvKey(approvalId: string): string {
    return `${KEY_PREFIX}${approvalId}`;
  }

  set(approvalId: string, data: string): Promise<void> {
    return this.kv.put(this.kvKey(approvalId), data);
  }

  get(approvalId: string): Promise<string | null> {
    return this.kv.get(this.kvKey(approvalId));
  }

  delete(approvalId: string): Promise<void> {
    return this.kv.delete(this.kvKey(approvalId));
  }

  async listKeys(): Promise<string[]> {
    const result = await this.kv.list({ prefix: KEY_PREFIX });
    return result.keys.map(({ name }) => name.slice(KEY_PREFIX.length));
  }
}
