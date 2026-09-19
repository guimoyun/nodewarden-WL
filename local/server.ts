// Local HTTP server: adapts Node's http server to the Workers fetch model
// used by src/index.ts, and bridges WebSocket upgrades into the local
// NotificationsHub Durable Object simulation.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
import type { LocalEnvBundle } from './env';
import type { LocalWebSocket } from './durable';

interface LocalCtx {
  waitUntil(promise: Promise<unknown>): void;
}

function headersFromIncoming(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : String(value));
  }
  return headers;
}

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks) : null));
    req.on('error', reject);
  });
}

export function startLocalServer(
  bundle: LocalEnvBundle,
  worker: { fetch(request: Request, env: unknown, ctx: LocalCtx): Promise<Response> },
  config: { host: string; port: number }
): { server: ReturnType<typeof createServer>; close(): Promise<void> } {
  const ctx: LocalCtx = {
    waitUntil(promise) {
      Promise.resolve(promise).catch((error) => console.error('[ctx.waitUntil] task failed:', error));
    },
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const method = (req.method || 'GET').toUpperCase();
      const hasBody = method !== 'GET' && method !== 'HEAD';
      const body = hasBody ? await readBody(req) : null;

      const headers = headersFromIncoming(req);
      let request: Request;
      if (body) {
        request = new Request(url, { method, headers, body: new Uint8Array(body), duplex: 'half' });
      } else {
        request = new Request(url, { method, headers });
      }

      const response = await worker.fetch(request, bundle.env, ctx);

      const responseHeaders = new Headers(response.headers);
      if (response.status === 101) {
        // A 101 from the worker without a bridged upgrade is not a real upgrade
        // in the local model; respond with 426 to be explicit.
        res.writeHead(426, { 'Content-Type': 'text/plain' });
        res.end('Upgrade required');
        return;
      }

      res.writeHead(response.status, Object.fromEntries(responseHeaders.entries()));
      if (method === 'HEAD' || !response.body) {
        res.end();
        return;
      }
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } catch (error) {
      console.error('[local-server] request error:', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      } else {
        res.end();
      }
    }
  });

  // --- WebSocket upgrades (/notifications/hub, /notifications/anonymous-hub) ---
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const isHub = url.pathname === '/notifications/hub' || url.pathname === '/notifications/anonymous-hub';
    if (!isHub) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (rawWs) => {
      void (async () => {
        try {
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (value === undefined) continue;
            headers.set(key, Array.isArray(value) ? value.join(', ') : String(value));
          }
          headers.set('Upgrade', 'websocket');
          headers.set('Connection', 'Upgrade');

          const request = new Request(url.toString(), { method: 'GET', headers });
          const hub = bundle.notificationsHub;
          const response = await hub.fetch(request);
          if (!hub.ctx._lastAccepted || response.status !== 200) {
            rawWs.close(1011, 'WebSocket handshake rejected');
            return;
          }

          const localWs = hub.ctx._lastAccepted as LocalWebSocket;
          hub.ctx._lastAccepted = null;

          // Bridge: localWs.send/close -> rawWs; rawWs events -> hub callbacks.
          localWs._bindRaw({
            send: (data) => rawWs.send(data as never),
            close: (code, reason) => rawWs.close(code, reason),
            readyState: rawWs.readyState,
          });

          rawWs.on('message', (data, isBinary) => {
            const text = isBinary ? (data as Buffer).toString('utf8') : String(data);
            const auto = hub.ctx._autoResponse;
            if (auto && text === auto.request) {
              try {
                rawWs.send(auto.response);
              } catch {
                // ignore
              }
              return;
            }
            try {
              if (typeof hub.ctx._owner?.webSocketMessage === 'function') {
                void hub.ctx._owner.webSocketMessage(localWs, isBinary ? (data as Buffer) : text);
              }
            } catch (error) {
              console.error('[local-server] webSocketMessage error:', error);
            }
          });

          rawWs.on('close', (code, reason) => {
            hub.ctx._removeSocket(localWs);
            try {
              if (typeof hub.ctx._owner?.webSocketClose === 'function') {
                void hub.ctx._owner.webSocketClose(localWs, code, reason?.toString() || '', true);
              }
            } catch (error) {
              console.error('[local-server] webSocketClose error:', error);
            }
          });

          rawWs.on('error', (error) => {
            try {
              if (typeof hub.ctx._owner?.webSocketError === 'function') {
                void hub.ctx._owner.webSocketError(localWs, error);
              }
            } catch {
              // ignore
            }
          });
        } catch (error) {
          console.error('[local-server] upgrade error:', error);
          rawWs.close(1011, 'Upgrade error');
        }
      })();
    });
  });

  server.listen(config.port, config.host, () => {
    console.log(`[nodewarden-local] listening on http://${config.host}:${config.port}`);
    console.log(`[nodewarden-local] data directory: ${(bundle as unknown as { dbPath: string }).dbPath || 'nw-data'}`);
  });

  return {
    server,
    close() {
      return new Promise<void>((resolve) => {
        wss.close();
        server.close(() => resolve());
      });
    },
  };
}
