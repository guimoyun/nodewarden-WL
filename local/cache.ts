// Local Cache API polyfill (caches.default / caches.open(name)).
// Implements the subset used by NodeWarden:
//   - caches.default.match(request) / put(request, response)
//   - caches.open('rate-limit').match/put with text bodies and max-age TTL

interface CacheEntry {
  body: Uint8Array;
  headers: Record<string, string>;
  status: number;
  expiresAt: number; // ms epoch; Infinity = no expiry
}

function parseMaxAge(cacheControl: string | undefined): number | null {
  if (!cacheControl) return null;
  if (/\bno-store\b/i.test(cacheControl)) return 0;
  if (/\bno-cache\b/i.test(cacheControl)) return 0;
  const match = /max-age=(\d+)/i.exec(cacheControl);
  return match ? Number(match[1]) : null;
}

class LocalCache {
  private readonly entries = new Map<string, CacheEntry>();

  async match(request: Request): Promise<Response | undefined> {
    const key = request.url;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return new Response(new Uint8Array(entry.body), {
      status: entry.status,
      headers: entry.headers,
    });
  }

  async put(request: Request, response: Response): Promise<void> {
    const key = request.url;
    const clone = response.clone();
    const body = new Uint8Array(await clone.arrayBuffer());
    const headers = Object.fromEntries(clone.headers.entries());
    const maxAge = parseMaxAge(clone.headers.get('cache-control') || undefined);
    const expiresAt = maxAge === null ? Infinity : Date.now() + maxAge * 1000;
    this.entries.set(key, { body, headers, status: clone.status, expiresAt });
  }

  async delete(request: Request): Promise<boolean> {
    return this.entries.delete(request.url);
  }
}

class LocalCacheStorage {
  private readonly named = new Map<string, LocalCache>();
  readonly default = new LocalCache();

  async open(name: string): Promise<LocalCache> {
    let cache = this.named.get(name);
    if (!cache) {
      cache = new LocalCache();
      this.named.set(name, cache);
    }
    return cache;
  }
}

export function installLocalCaches(): void {
  if (!(globalThis as unknown as { caches?: unknown }).caches) {
    (globalThis as unknown as { caches: unknown }).caches = new LocalCacheStorage();
  }
}
