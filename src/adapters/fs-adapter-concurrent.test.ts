/**
 * Tests for FileSystemAdapter concurrent delete safety (MG23-004 / RID-022, RID-023).
 *
 * Verifies that concurrent delete() calls for the same gateId do not produce
 * ENOENT races or orphaned lock files.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSystemAdapter } from './fs-adapter.js';

describe('FileSystemAdapter — concurrent delete()', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'meshgate-lock-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('does not throw when deleting a file that does not exist', async () => {
    const adapter = new FileSystemAdapter(tmpDir);
    // Should resolve silently — no ENOENT
    await expect(adapter.delete('nonexistent_gate')).resolves.toBeUndefined();
  });

  it('concurrent delete() calls for the same gateId do not throw', async () => {
    const adapter = new FileSystemAdapter(tmpDir);
    const gateId = 'concurrent_gate_1';

    // Create the gate file first
    await adapter.set(gateId, JSON.stringify({ schemaVersion: '1', approvalId: gateId }));

    // Fire 5 concurrent deletes for the same gate
    const deletes = Array.from({ length: 5 }, () => adapter.delete(gateId));
    await expect(Promise.all(deletes)).resolves.toBeDefined();
  });

  it('concurrent delete() calls leave no orphaned lock files', async () => {
    const adapter = new FileSystemAdapter(tmpDir);
    const gateId = 'concurrent_gate_2';

    await adapter.set(gateId, JSON.stringify({ schemaVersion: '1', approvalId: gateId }));

    const deletes = Array.from({ length: 10 }, () => adapter.delete(gateId));
    await Promise.allSettled(deletes);

    // Check the .meshgate directory for leftover .lock files
    const meshgateDir = join(tmpDir, '.meshgate');
    let entries: string[] = [];
    try {
      entries = await readdir(meshgateDir);
    } catch {
      // Directory may not exist if gate was never written — that's fine
    }

    const lockFiles = entries.filter((f) => f.endsWith('.lock'));
    expect(lockFiles).toHaveLength(0);
  });

  it('gate file is deleted after concurrent deletes', async () => {
    const adapter = new FileSystemAdapter(tmpDir);
    const gateId = 'concurrent_gate_3';

    await adapter.set(gateId, JSON.stringify({ schemaVersion: '1', approvalId: gateId }));

    const deletes = Array.from({ length: 3 }, () => adapter.delete(gateId));
    await Promise.allSettled(deletes);

    // File should be gone
    const content = await adapter.get(gateId);
    expect(content).toBeNull();
  });
});
