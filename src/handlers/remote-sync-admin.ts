import { Env, User, RemoteSyncSource } from '../types';
import { StorageService } from '../services/storage';
import {
  encryptSecret,
  synchronizeRemoteSourceById,
} from '../services/remote-sync';
import { jsonResponse, errorResponse } from '../utils/response';

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function randomUUID(): string {
  return crypto.randomUUID();
}

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeSource(source: RemoteSyncSource): Record<string, unknown> {
  return {
    id: source.id,
    url: source.url,
    email: source.email,
    syncIntervalMinutes: source.syncIntervalMinutes,
    enabled: source.enabled,
    status: source.status,
    lastSyncAt: source.lastSyncAt,
    lastResult: source.lastResult ? safeParseJson(source.lastResult) : null,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

function safeParseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeUrl(value: unknown): string {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(raw)) {
    throw new Error('网址必须以 http:// 或 https:// 开头');
  }
  return raw;
}

function normalizeEmail(value: unknown): string {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error('邮箱格式不正确');
  }
  return email;
}

function normalizeInterval(value: unknown): number {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 10080) {
    throw new Error('同步间隔须为 1 ~ 10080 分钟之间的整数');
  }
  return Math.round(minutes);
}

// GET /api/admin/remote-sync
export async function handleListRemoteSyncSources(request: Request, env: Env, actorUser: User): Promise<Response> {
  void request;
  void actorUser;
  const storage = new StorageService(env.DB);
  const sources = await storage.listRemoteSyncSources();
  return jsonResponse({ object: 'list', data: sources.map(sanitizeSource) });
}

// POST /api/admin/remote-sync
// body: { url, email, masterPassword, syncIntervalMinutes?, enabled? }
export async function handleCreateRemoteSyncSource(request: Request, env: Env, actorUser: User): Promise<Response> {
  void actorUser;
  const body = await readJsonBody(request);
  try {
    const url = normalizeUrl(body.url);
    const email = normalizeEmail(body.email);
    const masterPassword = String(body.masterPassword || '');
    if (!masterPassword) {
      return errorResponse('masterPassword is required', 400);
    }
    const syncIntervalMinutes = body.syncIntervalMinutes == null ? 60 : normalizeInterval(body.syncIntervalMinutes);
    const enabled = body.enabled == null ? true : !!body.enabled;

    const storage = new StorageService(env.DB);
    const now = nowIso();
    const source: RemoteSyncSource = {
      id: randomUUID(),
      url,
      email,
      encryptedPasswordHash: '',
      syncIntervalMinutes,
      enabled,
      status: 'idle',
      lastSyncAt: null,
      lastResult: null,
      createdAt: now,
      updatedAt: now,
    };

    // Persist the source first, then run an initial sync. The encrypted login
    // hash is produced inside synchronizeRemoteSourceById when the plaintext
    // master password is provided via override.
    await storage.saveRemoteSyncSource(source);
    const outcome = await synchronizeRemoteSourceById(env, source.id, { masterPasswordOverride: masterPassword });
    const syncedSource = outcome.source;
    const result = outcome.result;
    return jsonResponse(
      {
        object: 'remote-sync-source',
        ...sanitizeSource(syncedSource),
        syncResult: {
          ok: result.ok,
          added: result.added,
          updated: result.updated,
          skipped: result.skipped,
          folders: result.folders,
          attachments: result.attachments,
          attachmentsDownloaded: result.attachmentsDownloaded,
          warnings: result.warnings,
          error: result.error,
        },
      },
      result.ok ? 200 : 422
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(message, 400);
  }
}

// PUT /api/admin/remote-sync/:id
// body: { url?, email?, masterPassword?, syncIntervalMinutes?, enabled? }
export async function handleUpdateRemoteSyncSource(request: Request, env: Env, actorUser: User, sourceId: string): Promise<Response> {
  void actorUser;
  const storage = new StorageService(env.DB);
  const source = await storage.getRemoteSyncSource(sourceId);
  if (!source) {
    return errorResponse('Remote sync source not found', 404);
  }
  const body = await readJsonBody(request);
  const updated: RemoteSyncSource = { ...source };

  try {
    if (body.url != null) updated.url = normalizeUrl(body.url);
    if (body.email != null) updated.email = normalizeEmail(body.email);
    if (body.syncIntervalMinutes != null) updated.syncIntervalMinutes = normalizeInterval(body.syncIntervalMinutes);
    if (body.enabled != null) updated.enabled = !!body.enabled;
    updated.updatedAt = nowIso();
    await storage.saveRemoteSyncSource(updated);

    // If a new master password was supplied, re-seal credentials and sync now.
    if (body.masterPassword != null && String(body.masterPassword || '').length > 0) {
      const outcome = await synchronizeRemoteSourceById(env, source.id, {
        masterPasswordOverride: String(body.masterPassword),
      });
      return jsonResponse({
        object: 'remote-sync-source',
        ...sanitizeSource(outcome.source),
        syncResult: {
          ok: outcome.result.ok,
          added: outcome.result.added,
          updated: outcome.result.updated,
          skipped: outcome.result.skipped,
          folders: outcome.result.folders,
          attachments: outcome.result.attachments,
          attachmentsDownloaded: outcome.result.attachmentsDownloaded,
          warnings: outcome.result.warnings,
          error: outcome.result.error,
        },
      }, outcome.result.ok ? 200 : 422);
    }

    return jsonResponse({ object: 'remote-sync-source', ...sanitizeSource(updated) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(message, 400);
  }
}

// DELETE /api/admin/remote-sync/:id
export async function handleDeleteRemoteSyncSource(request: Request, env: Env, actorUser: User, sourceId: string): Promise<Response> {
  void request;
  void actorUser;
  const storage = new StorageService(env.DB);
  const source = await storage.getRemoteSyncSource(sourceId);
  if (!source) {
    return errorResponse('Remote sync source not found', 404);
  }
  await storage.deleteRemoteSyncSource(sourceId);
  return jsonResponse({ object: 'remote-sync-source', deleted: true, id: sourceId });
}

// POST /api/admin/remote-sync/:id/trigger
export async function handleTriggerRemoteSyncSource(request: Request, env: Env, actorUser: User, sourceId: string): Promise<Response> {
  void request;
  void actorUser;
  const storage = new StorageService(env.DB);
  const source = await storage.getRemoteSyncSource(sourceId);
  if (!source) {
    return errorResponse('Remote sync source not found', 404);
  }
  const outcome = await synchronizeRemoteSourceById(env, sourceId);
  return jsonResponse(
    {
      object: 'remote-sync-source',
      ...sanitizeSource(outcome.source),
      syncResult: {
        ok: outcome.result.ok,
        added: outcome.result.added,
        updated: outcome.result.updated,
          skipped: outcome.result.skipped,
        folders: outcome.result.folders,
        attachments: outcome.result.attachments,
        attachmentsDownloaded: outcome.result.attachmentsDownloaded,
        warnings: outcome.result.warnings,
        error: outcome.result.error,
      },
    },
    outcome.result.ok ? 200 : 422
  );
}
