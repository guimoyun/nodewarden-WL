// Local ASSETS binding: serves the built Web Vault from the dist directory.
// Mirrors the behavior of Cloudflare Workers static assets with SPA fallback
// (html_handling = "none", not_found_handling = "single-page-application").

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

export class LocalAssets {
  constructor(private readonly distDir: string) {}

  async fetch(request: Request): Promise<Response | null> {
    if (request.method !== 'GET' && request.method !== 'HEAD') return null;
    const url = new URL(request.url);
    let pathname = url.pathname;
    if (pathname.endsWith('/')) pathname += 'index.html';

    let filePath: string;
    try {
      filePath = path.normalize(path.join(this.distDir, decodeURIComponent(pathname)));
      if (!filePath.startsWith(this.distDir)) return new Response('Forbidden', { status: 403 });
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    let content: Buffer | null = null;
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile()) {
        content = await fs.readFile(filePath);
      }
    } catch {
      content = null;
    }

    if (content === null) {
      // SPA fallback: serve index.html for navigations.
      try {
        content = await fs.readFile(path.join(this.distDir, 'index.html'));
        filePath = path.join(this.distDir, 'index.html');
      } catch {
        return null; // dist not built yet
      }
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const headers = new Headers({ 'Content-Type': contentType });
    if (ext === '.html') headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');

    return new Response(request.method === 'HEAD' ? null : new Uint8Array(content), {
      status: 200,
      headers,
    });
  }
}
