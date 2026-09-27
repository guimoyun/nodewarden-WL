// Remote NodeWarden / Bitwarden password-vault synchronization.
//
// This module lets an admin register other NodeWarden (or Bitwarden-compatible)
// vaults as "sync sources" (URL + email + master password). On demand or on a
// schedule it logs into the remote vault over the standard Bitwarden protocol,
// pulls the user's key material + folders + ciphers (all stored encrypted), and
// mirrors them into the LOCAL vault so the same account/master-password can see
// the same entries across multiple nodes.
//
// Multi-master redundancy: several nodes may point at each other as sync
// sources. Because sync is pull-based (no push/queue), cycles converge rather
// than loop: every merge is idempotent (equal timestamps are skipped) and
// conflicts resolve by last-write-wins on the item's updatedAt/revisionDate, so
// the newest writer's version of an entry eventually reaches every node.
//
// Security notes:
// - The remote master-password-derived login hash is stored AES-256-GCM
//   encrypted with a key derived from JWT_SECRET. The plaintext master password
//   is never persisted.
// - Vault entries are end-to-end encrypted: the server only ever moves
//   ciphertext. A synced entry is decryptable by the local client only when the
//   local user holds the same user key as the remote user (i.e. the same
//   account created with the same master password). When a matching local user
//   has a different key, data sync is skipped with an explicit warning instead
//   of silently corrupting the local vault.

import type { Env, RemoteSyncSource, User, Cipher, Folder, Attachment, SyncConflict } from '../types';
import { StorageService } from './storage';
import { putBlobObject, getAttachmentObjectKey } from './blob-store';

const SYNC_DEVICE_TYPE = '14'; // web
const SYNC_DEVICE_NAME = 'NodeWarden Sync';
const DEFAULT_KDF_ITERATIONS = 600000;

export interface RemoteSyncResult {
  ok: boolean;
  added: number;
  updated: number;
  skipped: number;
  folders: number;
  attachments: number;
  attachmentsDownloaded: number;
  warnings: string[];
  error: string | null;
  startedAt: string;
  finishedAt: string;
  remoteUrl: string;
  remoteEmail: string;
  localUserId: string | null;
}

function parseTs(value: unknown): number {
  const n = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Credential sealing (AES-256-GCM, key derived from JWT_SECRET)
// ---------------------------------------------------------------------------

async function deriveSecretKey(env: Env): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.JWT_SECRET));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(env: Env, plaintext: string): Promise<string> {
  const key = await deriveSecretKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  const tag = sealed.slice(sealed.byteLength - 16);
  const body = sealed.slice(0, sealed.byteLength - 16);
  return [
    bytesToBase64(new Uint8Array(iv)),
    bytesToBase64(new Uint8Array(tag)),
    bytesToBase64(new Uint8Array(body)),
  ].join('.');
}

export async function decryptSecret(env: Env, sealed: string): Promise<string> {
  const [ivB64, tagB64, bodyB64] = String(sealed || '').split('.');
  if (!ivB64 || !tagB64 || !bodyB64) throw new Error('Malformed sealed secret');
  const key = await deriveSecretKey(env);
  const iv = base64ToBytes(ivB64);
  const tag = base64ToBytes(tagB64);
  const body = base64ToBytes(bodyB64);
  const payload = new Uint8Array(body.length + tag.length);
  payload.set(body, 0);
  payload.set(tag, body.length);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, payload);
  return new TextDecoder().decode(decrypted);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Bitwarden protocol primitives
// ---------------------------------------------------------------------------

async function pbkdf2(
  passwordOrBytes: string | Uint8Array,
  saltOrBytes: string | Uint8Array,
  iterations: number,
  length: number
): Promise<Uint8Array> {
  const pwdBytes: Uint8Array = typeof passwordOrBytes === 'string' ? new TextEncoder().encode(passwordOrBytes) : passwordOrBytes;
  const saltBytes: Uint8Array = typeof saltOrBytes === 'string' ? new TextEncoder().encode(saltOrBytes) : saltOrBytes;
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    pwdBytes,
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations },
    keyMaterial,
    length * 8
  );
  return new Uint8Array(bits);
}

export async function computeMasterPasswordHash(
  masterPassword: string,
  email: string,
  iterations: number
): Promise<string> {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const masterKey = await pbkdf2(masterPassword, normalizedEmail, iterations, 32);
  const hash = await pbkdf2(masterKey, masterPassword, 1, 32);
  return bytesToBase64(hash);
}

async function getRemotePreloginKdf(url: string, email: string): Promise<{ kdfType: number; kdfIterations: number }> {
  const resp = await fetch(`${url}/identity/accounts/prelogin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: String(email || '').trim().toLowerCase() }),
  });
  if (!resp.ok) {
    throw new Error(`远端库 prelogin 失败（HTTP ${resp.status}），请确认网址和邮箱正确`);
  }
  const data = (await resp.json()) as { kdf?: number; kdfIterations?: number };
  return {
    kdfType: Number(data.kdf ?? 0) || 0,
    kdfIterations: Number(data.kdfIterations || DEFAULT_KDF_ITERATIONS),
  };
}

async function loginRemoteVault(
  url: string,
  email: string,
  passwordHash: string
): Promise<{ accessToken: string; deviceIdentifier: string }> {
  const deviceIdentifier = crypto.randomUUID();
  const body = new URLSearchParams();
  body.set('grant_type', 'password');
  body.set('username', String(email || '').trim().toLowerCase());
  body.set('password', passwordHash);
  body.set('scope', 'api offline_access');
  body.set('client_id', 'web');
  body.set('deviceType', SYNC_DEVICE_TYPE);
  body.set('deviceIdentifier', deviceIdentifier);
  body.set('deviceName', SYNC_DEVICE_NAME);

  let resp: Response;
  try {
    resp = await fetch(`${url}/identity/connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch {
    throw new Error('无法连接远端库，请检查网址是否可访问');
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    if (/two_factor|2fa/i.test(text)) {
      throw new Error('远端库开启了两步验证，同步暂不支持开启 2FA 的账号');
    }
    if (resp.status === 400) {
      throw new Error('登录失败：邮箱或主密码不正确');
    }
    throw new Error(`登录远端库失败（HTTP ${resp.status}）`);
  }
  const data = (await resp.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error('登录远端库失败：未返回访问令牌');
  }
  return { accessToken: data.access_token, deviceIdentifier };
}

interface RemoteSyncPayload {
  profile: {
    id: string;
    email: string;
    name?: string | null;
    key?: string | null;
    privateKey?: string | null;
    accountKeys?: any | null;
    securityStamp?: string | null;
    kdfIterations?: number;
    creationDate?: string | null;
  };
  folders?: any[];
  ciphers?: any[];
}

async function fetchRemoteSync(url: string, accessToken: string): Promise<RemoteSyncPayload> {
  let resp: Response;
  try {
    resp = await fetch(`${url}/api/sync`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw new Error('连接远端库失败：无法拉取同步数据');
  }
  if (!resp.ok) {
    throw new Error(`拉取远端库同步数据失败（HTTP ${resp.status}）`);
  }
  const data = (await resp.json()) as RemoteSyncPayload;
  if (!data || !data.profile) {
    throw new Error('远端库返回的数据格式异常（缺少 profile）');
  }
  return data;
}

function extractRemotePublicKey(profile: RemoteSyncPayload['profile']): string | null {
  const accountKeys = profile.accountKeys as any;
  if (accountKeys && typeof accountKeys === 'object') {
    const pair = accountKeys.publicKeyEncryptionKeyPair as any;
    if (pair && typeof pair.publicKey === 'string' && pair.publicKey) return pair.publicKey;
    if (typeof accountKeys.publicKey === 'string' && accountKeys.publicKey) return accountKeys.publicKey;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Local merge
// ---------------------------------------------------------------------------

async function resolveLocalUser(
  storage: StorageService,
  profile: RemoteSyncPayload['profile'],
  passwordHash: string,
  warnings: string[]
): Promise<{ user: User; dataSyncAllowed: boolean }> {
  const remoteId = String(profile.id || '').trim();
  const remoteEmail = String(profile.email || '').trim().toLowerCase();
  const remoteKey = profile.key || '';

  const byId = remoteId ? await storage.getUserById(remoteId) : null;
  const existing = byId || (remoteEmail ? await storage.getUser(remoteEmail) : null);

  if (existing) {
    const keyMatches = !remoteKey || existing.key === remoteKey;
    const hasLocalData = (await storage.getAllCiphers(existing.id)).length > 0;
    if (!keyMatches) {
      if (hasLocalData) {
        warnings.push(
          '本地已存在同名账号（' + existing.email + '）但密钥与远端不一致：为避免损坏本地密码，未同步密码条目。' +
          '如需同步请使用与远端相同的主密码在本地注册该账号，或先删除本地该账号再同步。'
        );
        return { user: existing, dataSyncAllowed: false };
      }
      warnings.push('本地账号密钥与远端不一致，将以远端密钥覆盖（该账号本地暂无密码数据）');
    }
    return { user: existing, dataSyncAllowed: true };
  }

  const now = new Date().toISOString();
  const newUser: User = {
    id: remoteId || crypto.randomUUID(),
    email: remoteEmail,
    name: profile.name ?? null,
    masterPasswordHint: null,
    masterPasswordHash: passwordHash,
    key: remoteKey || '',
    privateKey: profile.privateKey ?? null,
    publicKey: extractRemotePublicKey(profile),
    kdfType: 0,
    kdfIterations: Number(profile.kdfIterations) || DEFAULT_KDF_ITERATIONS,
    securityStamp: crypto.randomUUID(),
    role: 'user',
    status: 'active',
    verifyDevices: false,
    totpSecret: null,
    totpRecoveryCode: null,
    yubikeyKey1: null,
    yubikeyKey2: null,
    yubikeyKey3: null,
    yubikeyKey4: null,
    yubikeyKey5: null,
    yubikeyNfc: false,
    apiKey: null,
    createdAt: profile.creationDate || now,
    updatedAt: now,
  };
  await storage.createUser(newUser);
  warnings.push(`已在本地创建账号 ${remoteEmail}（可使用相同主密码登录本地库查看同步的密码）`);
  return { user: newUser, dataSyncAllowed: true };
}

function normalizeRemoteFolderId(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  return value;
}

function buildLocalCipher(remoteCipher: any, userId: string): Cipher {
  const now = new Date().toISOString();
  // Bitwarden sync payloads use revisionDate/creationDate (NodeWarden/Bitwarden
  // wire format); some clients expose updatedAt/createdAt. Falling back to `now`
  // would make every sync look like a newer write and clobber local edits, so
  // only fall back when the payload really has no timestamp at all.
  const remoteUpdatedAt = remoteCipher.revisionDate ?? remoteCipher.updatedAt ?? null;
  const remoteCreatedAt = remoteCipher.creationDate ?? remoteCipher.createdAt ?? null;
  const remoteDeleted = remoteCipher.deletedDate ?? remoteCipher.deletedAt ?? null;
  const remoteArchived = remoteCipher.archivedAt ?? remoteCipher.archivedDate ?? null;
  const cipher = {
    ...(remoteCipher as Record<string, unknown>),
    id: String(remoteCipher.id || crypto.randomUUID()),
    userId,
    type: Number(remoteCipher.type) || 1,
    folderId: normalizeRemoteFolderId(remoteCipher.folderId),
    name: remoteCipher.name ?? null,
    notes: remoteCipher.notes ?? null,
    favorite: !!remoteCipher.favorite,
    login: remoteCipher.login ?? null,
    card: remoteCipher.card ?? null,
    identity: remoteCipher.identity ?? null,
    secureNote: remoteCipher.secureNote ?? null,
    sshKey: remoteCipher.sshKey ?? null,
    fields: remoteCipher.fields ?? null,
    passwordHistory: remoteCipher.passwordHistory ?? null,
    reprompt: Number(remoteCipher.reprompt) || 0,
    key: remoteCipher.key ?? null,
    createdAt: remoteCreatedAt || now,
    updatedAt: remoteUpdatedAt || now,
    archivedAt: remoteDeleted ? null : (remoteArchived ?? null),
    deletedAt: remoteDeleted ?? null,
  } as Cipher;
  delete (cipher as any).deletedDate;
  delete (cipher as any).archivedDate;
  delete (cipher as any).revisionDate;
  delete (cipher as any).creationDate;
  return cipher;
}

async function downloadRemoteAttachment(
  url: string,
  accessToken: string,
  cipherId: string,
  attachment: any,
  env: Env,
  warnings: string[]
): Promise<boolean> {
  try {
    const resp = await fetch(`${url}/api/ciphers/${cipherId}/attachment/${attachment.id}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) return false;
    const bytes = await resp.arrayBuffer();
    const key = getAttachmentObjectKey(cipherId, String(attachment.id));
    await putBlobObject(env, key, bytes, {
      contentType: 'application/octet-stream',
      size: bytes.byteLength,
    });
    return true;
  } catch {
    warnings.push(`附件 ${String(attachment.fileName || attachment.id)} 文件内容下载失败（将仅保留附件信息）`);
    return false;
  }
}

// Attachment metadata + best-effort file download for a merged cipher.
async function syncAttachments(
  url: string,
  accessToken: string,
  remoteCipher: any,
  cipherId: string,
  env: Env,
  storage: StorageService,
  result: RemoteSyncResult
): Promise<void> {
  for (const attachment of remoteCipher.attachments ?? []) {
    const localAttachment: Attachment = {
      id: String(attachment.id || crypto.randomUUID()),
      cipherId,
      fileName: String(attachment.fileName ?? ''),
      size: Number(attachment.size) || 0,
      sizeName: String(attachment.sizeName ?? ''),
      key: attachment.key ?? null,
    };
    await storage.saveAttachment(localAttachment);
    result.attachments += 1;
    const downloaded = await downloadRemoteAttachment(url, accessToken, cipherId, attachment, env, result.warnings);
    if (downloaded) result.attachmentsDownloaded += 1;
  }
}

// Record (upsert) a sync conflict: both nodes edited the same entry since the
// last merge. The last-write-wins merge already applied; this surfaces the fact
// for the admin to acknowledge. Result counters treat it like the merge it was.
async function recordSyncConflict(
  storage: StorageService,
  source: RemoteSyncSource,
  user: User,
  existing: Cipher,
  remoteVersion: Cipher,
  resolution: 'auto-remote' | 'auto-local',
  result: RemoteSyncResult
): Promise<void> {
  const now = new Date().toISOString();
  const conflict: SyncConflict = {
    id: crypto.randomUUID(),
    sourceId: source.id,
    userId: user.id,
    cipherId: existing.id,
    localUpdatedAt: existing.updatedAt,
    remoteUpdatedAt: remoteVersion.updatedAt,
    resolution,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    acknowledgedAt: null,
  };
  await storage.upsertSyncConflict(conflict);
  const winner = resolution === 'auto-remote' ? '远端' : '本地';
  const other = resolution === 'auto-remote' ? '本地' : '远端';
  result.warnings.push(
    `条目 ${existing.id.slice(0, 8)}… 在两端均有修改（${other} ${existing.updatedAt} / 远端 ${remoteVersion.updatedAt}），当前采用${winner}版本，可在管理页确认`
  );
}

export async function synchronizeRemoteSourceById(
  env: Env,
  sourceId: string,
  options?: { masterPasswordOverride?: string }
): Promise<{ source: RemoteSyncSource; result: RemoteSyncResult }> {
  const storage = new StorageService(env.DB);
  const source = await storage.getRemoteSyncSource(sourceId);
  if (!source) {
    throw new Error('同步源不存在');
  }

  const startedAt = new Date().toISOString();
  const result: RemoteSyncResult = {
    ok: false,
    added: 0,
    updated: 0,
    skipped: 0,
    folders: 0,
    attachments: 0,
    attachmentsDownloaded: 0,
    warnings: [],
    error: null,
    startedAt,
    finishedAt: startedAt,
    remoteUrl: source.url,
    remoteEmail: source.email,
    localUserId: null,
  };

  await storage.saveRemoteSyncSource({ ...source, status: 'syncing', updatedAt: startedAt });

  try {
    let passwordHash: string;
    if (options?.masterPasswordOverride) {
      const kdf = await getRemotePreloginKdf(source.url, source.email);
      if (kdf.kdfType !== 0) {
        throw new Error('远端库使用了 Argon2id KDF，当前版本仅支持 PBKDF2（KDF 0）');
      }
      passwordHash = await computeMasterPasswordHash(options.masterPasswordOverride, source.email, kdf.kdfIterations);
      const sealed = await encryptSecret(env, passwordHash);
      source.encryptedPasswordHash = sealed;
    } else {
      passwordHash = await decryptSecret(env, source.encryptedPasswordHash);
    }

    const { accessToken } = await loginRemoteVault(source.url, source.email, passwordHash);
    const syncData = await fetchRemoteSync(source.url, accessToken);
    const profile = syncData.profile;

    const { user, dataSyncAllowed } = await resolveLocalUser(storage, profile, passwordHash, result.warnings);

    if (dataSyncAllowed) {
      // Folders (names are encrypted strings; stored verbatim).
      // Multi-master: last-write-wins by revisionDate — a folder that is newer
      // locally is kept, an equal timestamp is skipped (idempotent), so two
      // nodes pointing at each other converge instead of overwriting each other.
      for (const folder of syncData.folders ?? []) {
        const folderId = String(folder.id || '');
        if (!folderId) continue;
        const remoteUpdatedAt = parseTs(folder.revisionDate);
        const existingFolder = await storage.getFolder(folderId);
        if (existingFolder && parseTs(existingFolder.updatedAt) >= remoteUpdatedAt) {
          continue; // local folder is same or newer
        }
        const localFolder: Folder = {
          id: folderId,
          userId: user.id,
          name: String(folder.name ?? ''),
          createdAt: folder.creationDate || new Date().toISOString(),
          updatedAt: folder.revisionDate || new Date().toISOString(),
        };
        await storage.saveFolder(localFolder);
        result.folders += 1;
      }

      // Ciphers — multi-master last-write-wins by updatedAt:
      //   - not present locally          → add (baseline = remote timestamp)
      //   - remote newer than local      → overwrite (updated)
      //   - remote same age or older     → skip (idempotent; keeps local edits)
      // Deletion/archival is just a state change on the same timestamp clock, so
      // a newer remote delete wins, and a newer local restore/edit beats an
      // older remote delete.
      //
      // Conflict detection: each entry tracks `lastSyncedAt` (the timestamp of
      // the last merge). If BOTH the local entry and the remote entry changed
      // since that baseline (and they disagree), both nodes edited the same
      // item — a sync conflict. The last-write-wins merge still applies, but a
      // conflict record is written so the admin page can surface and
      // acknowledge it instead of silently resolving it.
      for (const remoteCipher of syncData.ciphers ?? []) {
        const localCipher = buildLocalCipher(remoteCipher, user.id);
        const existing = await storage.getCipherForUser(localCipher.id, user.id);
        if (!existing) {
          result.added += 1;
          localCipher.lastSyncedAt = localCipher.updatedAt;
          await storage.saveCipher(localCipher);
          await syncAttachments(source.url, accessToken, remoteCipher, localCipher.id, env, storage, result);
          continue;
        }

        const remoteTs = parseTs(localCipher.updatedAt);
        const localTs = parseTs(existing.updatedAt);
        const baselineTs = parseTs(existing.lastSyncedAt);
        const localEdited = baselineTs > 0 && localTs > baselineTs;
        const remoteEdited = baselineTs > 0 && remoteTs > baselineTs;
        const isConflict = localEdited && remoteEdited && remoteTs !== localTs;

        if (remoteTs === localTs) {
          // Idempotent: same version both sides. Catch up the baseline so
          // future conflict detection works (legacy rows have no baseline).
          result.skipped += 1;
          if (!existing.lastSyncedAt || baselineTs !== localTs) {
            existing.lastSyncedAt = existing.updatedAt;
            await storage.saveCipher(existing);
          }
          continue;
        }

        if (remoteTs > localTs) {
          // Remote is the newer writer.
          if (isConflict) {
            await recordSyncConflict(storage, source, user, existing, localCipher, 'auto-remote', result);
          }
          result.updated += 1;
          localCipher.lastSyncedAt = localCipher.updatedAt;
          await storage.saveCipher(localCipher);
        } else {
          // Local is the newer writer — keep it, advance the baseline so the
          // local edit is no longer flagged on the next merge.
          if (isConflict) {
            await recordSyncConflict(storage, source, user, existing, localCipher, 'auto-local', result);
          }
          result.skipped += 1;
          if (baselineTs !== localTs) {
            existing.lastSyncedAt = existing.updatedAt;
            await storage.saveCipher(existing);
          }
          continue;
        }

        await syncAttachments(source.url, accessToken, remoteCipher, localCipher.id, env, storage, result);
      }

      await storage.updateRevisionDate(user.id);
      result.localUserId = user.id;
    }

    const finishedAt = new Date().toISOString();
    result.ok = true;
    result.finishedAt = finishedAt;

    const updatedSource: RemoteSyncSource = {
      ...source,
      status: 'ok',
      lastSyncAt: finishedAt,
      lastResult: JSON.stringify({
        ok: true,
        added: result.added,
        updated: result.updated,
        skipped: result.skipped,
        folders: result.folders,
        attachments: result.attachments,
        attachmentsDownloaded: result.attachmentsDownloaded,
        warnings: result.warnings,
        localUserId: user.id,
        keyMismatchSkipped: !dataSyncAllowed,
      }),
      updatedAt: finishedAt,
    };
    if (options?.masterPasswordOverride) {
      updatedSource.encryptedPasswordHash = source.encryptedPasswordHash;
    }
    await storage.saveRemoteSyncSource(updatedSource);
    return { source: updatedSource, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.error = message;
    const finishedAt = new Date().toISOString();
    result.finishedAt = finishedAt;
    const updatedSource: RemoteSyncSource = {
      ...source,
      status: 'error',
      lastSyncAt: null,
      lastResult: JSON.stringify({ ok: false, error: message, warnings: result.warnings }),
      updatedAt: finishedAt,
    };
    await storage.saveRemoteSyncSource(updatedSource);
    return { source: updatedSource, result };
  }
}

// ---------------------------------------------------------------------------
// Scheduled sync
// ---------------------------------------------------------------------------

export async function runScheduledRemoteSyncIfDue(env: Env): Promise<void> {
  const storage = new StorageService(env.DB);
  const sources = await storage.listRemoteSyncSources();
  const now = Date.now();
  for (const source of sources) {
    if (!source.enabled) continue;
    if (source.status === 'syncing') continue;
    const intervalMs = Math.max(1, Number(source.syncIntervalMinutes) || 60) * 60 * 1000;
    if (!source.lastSyncAt || now - Date.parse(source.lastSyncAt) >= intervalMs) {
      try {
        await synchronizeRemoteSourceById(env, source.id);
      } catch (error) {
        console.error('[nodewarden] scheduled remote sync failed:', source.id, error);
      }
    }
  }
}
