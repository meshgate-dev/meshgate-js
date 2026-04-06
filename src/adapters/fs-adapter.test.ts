import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileSystemAdapter } from './fs-adapter.js';

let dir: string;
let adapter: FileSystemAdapter;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'meshgate-test-'));
  adapter = new FileSystemAdapter(dir);
});

afterEach(async () => {
  // Clean up temp dir
  const { rm } = await import('node:fs/promises');
  await rm(dir, { recursive: true, force: true });
});

describe('FileSystemAdapter', () => {
  it('set() creates .meshgate dir and writes the file', async () => {
    await adapter.set('gate_abc', '{"data":"encrypted"}');
    const entries = await readdir(join(dir, '.meshgate'));
    expect(entries).toContain('gate_abc.json');
  });

  it('get() returns stored data', async () => {
    await adapter.set('gate_abc', '{"data":"encrypted"}');
    const result = await adapter.get('gate_abc');
    expect(result).toBe('{"data":"encrypted"}');
  });

  it('get() returns null for missing key', async () => {
    const result = await adapter.get('nonexistent');
    expect(result).toBeNull();
  });

  it('delete() removes the file', async () => {
    await adapter.set('gate_abc', 'value');
    await adapter.delete('gate_abc');
    const result = await adapter.get('gate_abc');
    expect(result).toBeNull();
  });

  it('delete() is idempotent — does not throw for missing key', async () => {
    await expect(adapter.delete('nonexistent')).resolves.toBeUndefined();
  });

  it('listKeys() returns all stored approvalIds', async () => {
    await adapter.set('gate_1', 'a');
    await adapter.set('gate_2', 'b');
    await adapter.set('gate_3', 'c');
    const keys = await adapter.listKeys();
    expect(keys.sort()).toEqual(['gate_1', 'gate_2', 'gate_3']);
  });

  it('listKeys() returns [] when .meshgate dir does not exist', async () => {
    const fresh = new FileSystemAdapter(join(dir, 'nonexistent-subdir'));
    const keys = await fresh.listKeys();
    expect(keys).toEqual([]);
  });

  it('listKeys() ignores non-.json files', async () => {
    await adapter.set('gate_valid', 'data');
    // Manually write a non-json file into .meshgate
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, '.meshgate'), { recursive: true });
    await writeFile(join(dir, '.meshgate', 'README.txt'), 'ignore me');
    const keys = await adapter.listKeys();
    expect(keys).toEqual(['gate_valid']);
  });

  it('set() creates .meshgate dir if it does not exist', async () => {
    const fresh = new FileSystemAdapter(join(dir, 'deep', 'nested'));
    await fresh.set('gate_x', 'payload');
    const result = await fresh.get('gate_x');
    expect(result).toBe('payload');
  });
});
