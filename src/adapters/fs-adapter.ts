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

import { MeshgateConfigError } from '../errors.js';
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
    return `${this.dir}/${approvalId}.json`;
  }

  async set(approvalId: string, data: string): Promise<void> {
    const fs = await getFsPromises();
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.keyPath(approvalId), data, 'utf-8');
  }

  async get(approvalId: string): Promise<string | null> {
    const fs = await getFsPromises();
    try {
      return await fs.readFile(this.keyPath(approvalId), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(approvalId: string): Promise<void> {
    const fs = await getFsPromises();
    try {
      await fs.unlink(this.keyPath(approvalId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  async listKeys(): Promise<string[]> {
    const fs = await getFsPromises();
    try {
      const entries = await fs.readdir(this.dir);
      return entries.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }
}
