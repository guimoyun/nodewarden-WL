// Local simulation of Cloudflare Durable Objects runtime.
// Provides just enough of the Workers surface used by NodeWarden:
//   - DurableObject base class + waitUntil (replaces 'cloudflare:workers')
//   - DurableObjectState: storage get/put/delete, WebSocket connection pool,
//     setWebSocketAutoResponse, acceptWebSocket, getWebSockets
//   - WebSocketPair, WebSocketRequestResponsePair
//   - DurableObjectNamespace: idFromName(name).get(id).fetch(...) -> in-process calls
//
// The actual wire protocol (WebSocket frames) is bridged in local/server.ts via
// the `ws` package; LocalWebSocket here is the logical object NodeWarden code
// talks to, and `_bindRaw()` attaches a real ws socket for I/O.

type LocalRawSocket = {
  send(data: string | Buffer | ArrayBuffer, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
  readyState: number;
};

const WS_OPEN = 1;
const WS_CLOSED = 3;

export class LocalWebSocket {
  private attachment: unknown = null;
  private raw: LocalRawSocket | null = null;
  private pendingSends: Array<string | Uint8Array> = [];

  onmessage: ((ev: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readyState: number = WS_OPEN;

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    let payload: string | Uint8Array;
    if (typeof data === 'string') {
      payload = data;
    } else if (data instanceof ArrayBuffer) {
      payload = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data)) {
      payload = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else {
      return;
    }

    if (this.raw && this.raw.readyState === WS_OPEN) {
      try {
        this.raw.send(payload);
      } catch {
        // send race: drop.
      }
    } else {
      // Socket not yet bridged (handshake in progress); queue until bound.
      this.pendingSends.push(payload);
    }
  }

  close(code = 1000, reason = ''): void {
    this.readyState = WS_CLOSED;
    if (this.raw && this.raw.readyState === WS_OPEN) {
      try {
        this.raw.close(code, reason);
      } catch {
        // ignore
      }
    }
    this.pendingSends = [];
  }

  serializeAttachment(attachment: unknown): void {
    this.attachment = attachment;
  }

  deserializeAttachment<T = unknown>(): T | null {
    return this.attachment as T | null;
  }

  /** Bridge to a real ws socket (called by local/server.ts after upgrade). */
  _bindRaw(raw: LocalRawSocket): void {
    this.raw = raw;
    for (const pending of this.pendingSends) {
      if (raw.readyState === WS_OPEN) {
        try {
          raw.send(pending);
        } catch {
          // ignore
        }
      }
    }
    this.pendingSends = [];
  }
}

export class WebSocketPair {
  0: LocalWebSocket;
  1: LocalWebSocket;

  constructor() {
    this[0] = new LocalWebSocket();
    this[1] = new LocalWebSocket();
  }
}

export class WebSocketRequestResponsePair {
  constructor(
    public readonly request: string,
    public readonly response: string
  ) {}
}

export class LocalStorage {
  private readonly map = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | null> {
    return this.map.has(key) ? (structuredClone(this.map.get(key)) as T) : null;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.map.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  async list(): Promise<string[]> {
    return Array.from(this.map.keys());
  }
}

export class LocalDurableObjectState {
  readonly storage = new LocalStorage();
  private readonly sockets: LocalWebSocket[] = [];
  private autoResponse: WebSocketRequestResponsePair | null = null;

  /** Owner instance (set by LocalDurableObject constructor). */
  _owner: { webSocketMessage?: (...args: unknown[]) => unknown; webSocketClose?: (...args: unknown[]) => unknown; webSocketError?: (...args: unknown[]) => unknown } | null = null;
  /** Last accepted WebSocket waiting to be bridged by the HTTP layer. */
  _lastAccepted: LocalWebSocket | null = null;
  _autoResponse: WebSocketRequestResponsePair | null = null;

  acceptWebSocket(ws: LocalWebSocket, _tags?: string[]): void {
    this.sockets.push(ws);
    this._lastAccepted = ws;
  }

  getWebSockets(tag?: string): LocalWebSocket[] {
    return this.sockets.filter((ws) => {
      if (!tag) return true;
      const attachment = ws.deserializeAttachment<{ deviceIdentifier?: string | null; kind?: string } | null>();
      if (!attachment) return true;
      // Device-tagged filtering: sockets are filtered by `device:<identifier>`.
      const tagValue = tag.replace(/^device:/, '');
      return attachment.deviceIdentifier === tagValue || tag === `device:${attachment.deviceIdentifier}`;
    });
  }

  setWebSocketAutoResponse(pair: WebSocketRequestResponsePair): void {
    this.autoResponse = pair;
    this._autoResponse = pair;
  }

  getAutoResponse(): WebSocketRequestResponsePair | null {
    return this.autoResponse;
  }

  _removeSocket(ws: LocalWebSocket): void {
    const idx = this.sockets.indexOf(ws);
    if (idx >= 0) this.sockets.splice(idx, 1);
    if (this._lastAccepted === ws) this._lastAccepted = null;
  }
}

export class LocalDurableObject {
  protected ctx: LocalDurableObjectState;
  env: unknown;

  constructor(ctx: LocalDurableObjectState, env: unknown) {
    this.ctx = ctx;
    this.env = env;
    ctx._owner = this as unknown as LocalDurableObjectState['_owner'];
  }

  async fetch(_request: Request): Promise<Response> {
    return new Response('Not implemented', { status: 500 });
  }
}

/** Non-blocking waitUntil equivalent: run the promise in the background. */
export function waitUntil(promise: Promise<unknown>): void {
  Promise.resolve(promise).catch((error) => {
    console.error('[waitUntil] background task failed:', error);
  });
}

export class LocalDurableObjectNamespace {
  private instance: { fetch(request: Request): Promise<Response> } | null = null;

  constructor(
    private readonly factory: () => { fetch(request: Request): Promise<Response>; ctx: LocalDurableObjectState },
    private readonly singletonName = 'singleton'
  ) {}

  idFromName(name: string): { name: string; toString(): string } {
    return { name, toString: () => `local:${name}` };
  }

  get(_id: { name?: string }): { fetch(url: string | URL, init?: RequestInit): Promise<Response> } {
    return {
      fetch: async (url, init) => {
        const instance = this.getInstance();
        const request = new Request(url, init);
        return instance.fetch(request);
      },
    };
  }

  /** Access the singleton instance (used by local/server.ts for WebSocket bridging). */
  _getInstance(): { fetch(request: Request): Promise<Response>; ctx: LocalDurableObjectState } {
    return this.getInstance();
  }

  private getInstance(): { fetch(request: Request): Promise<Response>; ctx: LocalDurableObjectState } {
    if (!this.instance) {
      this.instance = this.factory();
    }
    return this.instance;
  }
}

// --- Global wiring ----------------------------------------------------------
// In Cloudflare Workers these constructors are ambient globals. Register them
// on globalThis so src/durable/notifications-hub.ts can run unmodified.
const G = globalThis as unknown as {
  WebSocketPair?: unknown;
  WebSocketRequestResponsePair?: unknown;
};

if (!G.WebSocketPair) {
  G.WebSocketPair = WebSocketPair;
}
if (!G.WebSocketRequestResponsePair) {
  G.WebSocketRequestResponsePair = WebSocketRequestResponsePair;
}
