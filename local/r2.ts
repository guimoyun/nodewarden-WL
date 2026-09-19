// Local R2Bucket-compatible implementation backed by a local directory.
// Implements the surface used by NodeWarden (see services/blob-store.ts):
//   put(key, value, { httpMetadata, customMetadata })
//   get(key) -> { body, size, httpMetadata?.contentType, customMetadata }
//   delete(key)

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';

interface R2HttpMetadata {
  contentType?: string;
}

interface PutOptions {
  httpMetadata?: R2HttpMetadata;
  customMetadata?: Record<string, string>;
}

interface R2Object {
  key: string;
  body: ReadableStream | null;
  size: number;
  httpMetadata: R2HttpMetadata | null;
  customMetadata: Record<string, string> | null;
}

function isReadableStream(value: unknown): value is ReadableStream {
  return typeof (value as ReadableStream)?.getReader === 'function';
}

export class LocalR2Bucket {
  constructor(private readonly rootDir: string) {}

  private metaPath(key: string): string {
    return path.join(this.rootDir, '.meta', key + '.json');
  }

  private dataPath(key: string): string {
    return path.join(this.rootDir, key);
  }

  private assertSafeKey(key: string): void {
    if (!key || key.includes('\0')) throw new Error('Invalid R2 key');
    const normalized = path.normalize(key);
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) throw new Error('Invalid R2 key');
  }

  async put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream, options?: PutOptions): Promise<void> {
    this.assertSafeKey(key);
    let buffer: Buffer;
    if (typeof value === 'string') {
      buffer = Buffer.from(value, 'utf8');
    } else if (value instanceof ArrayBuffer) {
      buffer = Buffer.from(new Uint8Array(value));
    } else if (ArrayBuffer.isView(value)) {
      buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    } else if (isReadableStream(value)) {
      const reader = value.getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        chunks.push(chunk as Uint8Array);
      }
      buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    } else {
      throw new Error('Unsupported R2 value type');
    }

    const target = this.dataPath(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, buffer);

    const meta = {
      size: buffer.byteLength,
      contentType: options?.httpMetadata?.contentType || null,
      customMetadata: options?.customMetadata || null,
    };
    const mpath = this.metaPath(key);
    await fs.mkdir(path.dirname(mpath), { recursive: true });
    await fs.writeFile(mpath, JSON.stringify(meta), 'utf8');
  }

  async get(key: string): Promise<R2Object | null> {
    this.assertSafeKey(key);
    try {
      const buffer = await fs.readFile(this.dataPath(key));
      const meta = await this.readMeta(key);
      return {
        key,
        body: Readable.toWeb(buffer as unknown as Buffer) as unknown as ReadableStream,
        size: buffer.byteLength,
        httpMetadata: meta?.contentType ? { contentType: meta.contentType } : null,
        customMetadata: meta?.customMetadata || null,
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async head(key: string): Promise<{ key: string; size: number; httpMetadata: R2HttpMetadata | null; customMetadata: Record<string, string> | null } | null> {
    this.assertSafeKey(key);
    try {
      const stat = await fs.stat(this.dataPath(key));
      const meta = await this.readMeta(key);
      return {
        key,
        size: stat.size,
        httpMetadata: meta?.contentType ? { contentType: meta.contentType } : null,
        customMetadata: meta?.customMetadata || null,
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    this.assertSafeKey(key);
    await fs.rm(this.dataPath(key), { force: true });
    await fs.rm(this.metaPath(key), { force: true });
  }

  async list(prefix = ''): Promise<{ objects: Array<{ key: string; size: number }>; truncated: boolean; cursor: string | null }> {
    this.assertSafeKey(prefix);
    const objects: Array<{ key: string; size: number }> = [];
    const walk = async (dir: string, rel: string) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(full, relPath);
        } else {
          const stat = await fs.stat(full);
          objects.push({ key: relPath, size: stat.size });
        }
      }
    };
    await walk(path.join(this.rootDir, prefix), prefix);
    return { objects, truncated: false, cursor: null };
  }

  private async readMeta(key: string): Promise<{ size?: number; contentType?: string; customMetadata?: Record<string, string> | null } | null> {
    try {
      const raw = await fs.readFile(this.metaPath(key), 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}
