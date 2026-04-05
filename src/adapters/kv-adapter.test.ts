import { beforeEach, describe, expect, it } from 'vitest';

import { CloudflareKVAdapter, type KVNamespaceLike } from './kv-adapter.js';

/** In-memory mock of KVNamespaceLike for tests. */
function createMockKV(): KVNamespaceLike {
  const store = new Map<string, string>();
  return {
    put: (key, value) => {
      store.set(key, value);
      return Promise.resolve();
    },
    get: (key) => Promise.resolve(store.get(key) ?? null),
    delete: (key) => {
      store.delete(key);
      return Promise.resolve();
    },
    list: ({ prefix } = {}) => {
      const keys = [...store.keys()]
        .filter((k) => (prefix ? k.startsWith(prefix) : true))
        .map((name) => ({ name }));
      return Promise.resolve({ keys });
    },
  };
}

let kv: KVNamespaceLike;
let adapter: CloudflareKVAdapter;

beforeEach(() => {
  kv = createMockKV();
  adapter = new CloudflareKVAdapter(kv);
});

describe('CloudflareKVAdapter', () => {
  it('set() stores value under mg: prefixed key', async () => {
    await adapter.set('gate_abc', '{"encrypted":"data"}');
    const raw = await kv.get('mg:gate_abc');
    expect(raw).toBe('{"encrypted":"data"}');
  });

  it('get() retrieves stored value', async () => {
    await adapter.set('gate_abc', '{"encrypted":"data"}');
    const result = await adapter.get('gate_abc');
    expect(result).toBe('{"encrypted":"data"}');
  });

  it('get() returns null for missing key', async () => {
    const result = await adapter.get('nonexistent');
    expect(result).toBeNull();
  });

  it('delete() removes the key', async () => {
    await adapter.set('gate_abc', 'value');
    await adapter.delete('gate_abc');
    const result = await adapter.get('gate_abc');
    expect(result).toBeNull();
  });

  it('delete() is idempotent — does not throw for missing key', async () => {
    await expect(adapter.delete('nonexistent')).resolves.toBeUndefined();
  });

  it('listKeys() returns all approvalIds without the mg: prefix', async () => {
    await adapter.set('gate_1', 'a');
    await adapter.set('gate_2', 'b');
    const keys = await adapter.listKeys();
    expect(keys.sort()).toEqual(['gate_1', 'gate_2']);
  });

  it('listKeys() returns [] when namespace is empty', async () => {
    const keys = await adapter.listKeys();
    expect(keys).toEqual([]);
  });

  it('listKeys() does not include keys without the mg: prefix', async () => {
    // Simulate a KV namespace shared with other keys
    await kv.put('other:key', 'unrelated');
    await adapter.set('gate_1', 'data');
    const keys = await adapter.listKeys();
    expect(keys).toEqual(['gate_1']);
  });
});
