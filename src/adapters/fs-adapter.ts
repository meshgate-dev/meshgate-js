/**
 * FileSystemAdapter — Node.js storage adapter for @meshgate/sdk.
 *
 * Stores each gate's encrypted state as `.meshgate/{approvalId}.json`
 * relative to `baseDir` (defaults to `process.cwd()`).
 *
 * This adapter is NOT safe for use in Cloudflare Workers, Vercel Edge,
 * or Deno Deploy — use CloudflareKVAdapter or NoopAdapter in those
 * environments.
 *
 * Throws `MeshgateConfigError` if `node:fs/promises` is unavailable
 * (i.e., the runtime is not Node.js / Bun).
 */

import lockfile from 'proper-lockfile';
import { MeshgateConfigError, MeshgateError } from '../errors.js';
import type { MeshgateStorageAdapter } from './types.js';

type FsPromises = typeof import('node:fs/promises');

async function getFsPromises(): Promise<FsPromises> {
  try {
    return await import('node:fs/promises');
  } catch {
    throw new MeshgateConfigError(
      'FileSystemAdapter requires Node.js or Bun. ' +
        'Use CloudflareKVAdapter or NoopAdapter in edge runtimes.',
    );
  }
}

export class FileSystemAdapter implements MeshgateStorageAdapter {
  private readonly baseDir: string;
  private readonly dir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? process.cwd();
    this.dir = `${this.baseDir}/.meshgate`;
  }

  private keyPath(approvalId: string): string {
    if (approvalId.includes('/') || approvalId.includes('\\') || approvalId.includes('..')) {
      throw new MeshgateConfigError(
        `Invalid approvalId "${approvalId}": must not contain /, \\, or ..`,
      );
    }
    return `${this.dir}/${approvalId}.json`;
  }

  async set(approvalId: string, data: string): Promise<void> {
    const fs = await getFsPromises();
    await fs.mkdir(this.dir, { recursive: true });
    const file = this.keyPath(approvalId);
    // Touch the file so lockfile.lock() can acquire an advisory lock on it,
    // then write the real content under the lock to prevent torn reads.
    await fs.writeFile(file, '', 'utf-8');
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(file, { stale: 5000, retries: 3 });
      await fs.writeFile(file, data, 'utf-8');
    } catch (err) {
      throw new MeshgateError(`Failed to write gate record: ${String(err)}`);
    } finally {
      if (release) await release();
    }
  }

  async get(approvalId: string): Promise<string | null> {
    const fs = await getFsPromises();
    try {
      return await fs.readFile(this.keyPath(approvalId), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new MeshgateError(`Failed to read gate record: ${String(err)}`);
    }
  }

  async delete(approvalId: string): Promise<void> {
    const fs = await getFsPromises();
    const file = this.keyPath(approvalId);
    // Advisory lock prevents concurrent process corruption (stale: 5s covers crash mid-lock).
    // lockfile.lock() throws ENOENT if the file no longer exists — treat as already deleted.
    let release: (() => Promise<void>) | undefined;
    try {
      // retries: minTimeout 50ms, maxTimeout 500ms keeps test + prod overhead low
      // while still safely surviving brief competing-process lock holds.
      release = await lockfile.lock(file, { stale: 5000, retries: { retries: 3, minTimeout: 50, maxTimeout: 500 } });
      try {
        await fs.unlink(file);
      } catch (unlinkErr) {
        // If the file is already gone by the time we unlink, treat as success (idempotent).
        // This avoids the TOCTTOU race of a separate fs.access() existence check.
        if ((unlinkErr as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw new MeshgateError(`Failed to delete gate record: ${String(unlinkErr)}`);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return; // file never existed or already deleted before lock
      if (code === 'ELOCKED') {
        // Retries exhausted while another concurrent caller holds the lock and is
        // likely deleting this file. Attempt a direct unlink — if the file is already
        // gone (ENOENT), treat as success (idempotent). This avoids the TOCTTOU race
        // of a separate fs.access() check.
        try {
          await fs.unlink(file);
        } catch (unlinkErr) {
          if ((unlinkErr as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw new MeshgateError(`Failed to delete gate record: could not acquire lock after retries`);
        }
        return;
      }
      throw err instanceof MeshgateError ? err : new MeshgateError(`Failed to delete gate record: ${String(err)}`);
    } finally {
      if (release) await release();
    }
  }

  async listKeys(): Promise<string[]> {
    const fs = await getFsPromises();
    try {
      const entries = await fs.readdir(this.dir);
      return entries.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new MeshgateError(`Failed to list gate records: ${String(err)}`);
    }
  }
}
