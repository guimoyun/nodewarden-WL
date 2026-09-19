// Local KVNamespace-compatible implementation backed by a local directory.
// Implements the surface used by NodeWarden (see services/blob-store.ts KV path):
//   put(key, value, { metadata })
//   getWithMetadata(key, 'arrayBuffer') -> { value, metadata }
//   get(key, type?)   delete(key)   list()

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

type GetType = 'text' | 'arrayBuffer' | 'json' | 'stream';

interface PutOptions {
  metadata?: Record<string, unknown> | null;
  expirationTtl?: number;
}

export class LocalKVNamespace {
  constructor(private readonly rootDir: string) {}

  private dataPath(key: string): string {
    return path.join(this.rootDir, key);
  }

  private metaPath(key: string): string {
    return path.join(this.rootDir, '.meta', key + '.json');
  }

  private assertSafeKey(key: string): void {
    if (!key || key.includes('\0')) throw new Error('Invalid KV key');
    const normalized = path.normalize(key);
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) throw new Error('Invalid KV key');
  }

  async put(key: string, value: string | ArrayBuffer | ArrayBufferView, options?: PutOptions): Promise<void> {
    this.assertSafeKey(key);
    let buffer: Buffer;
    if (typeof value === 'string') {
      buffer = Buffer.from(value, 'utf8');
    } else if (value instanceof ArrayBuffer) {
      buffer = Buffer.from(new Uint8Array(value));
    } else if (ArrayBuffer.isView(value)) {
      buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    } else {
      throw new Error('Unsupported KV value type');
    }

    const target = this.dataPath(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, buffer);

    if (options?.metadata) {
      const mpath = this.metaPath(key);
      await fs.mkdir(path.dirname(mpath), { recursive: true });
      await fs.writeFile(mpath, JSON.stringify(options.metadata), 'utf8');
    } else {
      await fs.rm(this.metaPath(key), { force: true });
    }
  }

  async get(key: string): Promise<string | null>;
  async get(key: string, type: 'text'): Promise<string | null>;
  async get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>;
  async get(key: string, type: 'json'): Promise<unknown | null>;
  async get(key: string, type: 'stream'): Promise<ReadableStream | null>;
  async get(key: string, type: GetType = 'text'): Promise<unknown | null> {
    this.assertSafeKey(key);
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(this.dataPath(key));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }

    switch (type) {
      case 'arrayBuffer':
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
      case 'json':
        try {
          return JSON.parse(buffer.toString('utf8'));
        } catch {
          return null;
        }
      case 'stream':
        return new Response(buffer).body;
      case 'text':
      default:
        return buffer.toString('utf8');
    }
  }

  async getWithMetadata<T = Record<string, unknown>>(
    key: string,
    type: 'text' | 'arrayBuffer' | 'json' = 'text'
  ): Promise<{ value: unknown; metadata: T | null }> {
    const value = await this.get(key, type);
    let metadata: T | null = null;
    try {
      const raw = await fs.readFile(this.metaPath(key), 'utf8');
      metadata = JSON.parse(raw) as T;
    } catch {
      metadata = null;
    }
    return { value, metadata };
  }

  async delete(key: string): Promise<void> {
    this.assertSafeKey(key);
    await fs.rm(this.dataPath(key), { force: true });
    await fs.rm(this.metaPath(key), { force: true });
  }

  async list(prefix = ''): Promise<{ keys: Array<{ name: string; metadata?: unknown }>; list_complete: boolean; cursor: string | null }> {
    this.assertSafeKey(prefix);
    const keys: Array<{ name: string; metadata?: unknown }> = [];
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
          let metadata: unknown;
          try {
            metadata = JSON.parse(await fs.readFile(this.metaPath(relPath), 'utf8'));
          } catch {
            metadata = undefined;
          }
          keys.push({ name: relPath, ...(metadata !== undefined ? { metadata } : {}) });
        }
      }
    };
    await walk(path.join(this.rootDir, prefix), prefix);
    return { keys, list_complete: true, cursor: null };
  }
}
