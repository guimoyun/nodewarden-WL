import { t } from '../i18n';
import type { AuthedFetch } from './shared';
import { parseErrorMessage, parseJson } from './shared';

export interface RemoteSyncSourceRecord {
  id: string;
  url: string;
  email: string;
  syncIntervalMinutes: number;
  enabled: boolean;
  status: 'idle' | 'syncing' | 'ok' | 'error';
  lastSyncAt: string | null;
  lastResult: {
    ok?: boolean;
    added?: number;
    updated?: number;
    folders?: number;
    attachments?: number;
    attachmentsDownloaded?: number;
    warnings?: string[];
    error?: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteSyncSourceResponse extends RemoteSyncSourceRecord {
  syncResult?: {
    ok: boolean;
    added: number;
    updated: number;
    folders: number;
    attachments: number;
    attachmentsDownloaded: number;
    warnings: string[];
    error: string | null;
  };
}

export async function listRemoteSyncSources(authedFetch: AuthedFetch): Promise<RemoteSyncSourceRecord[]> {
  const resp = await authedFetch('/api/admin/remote-sync');
  if (!resp.ok) throw new Error(await parseErrorMessage(resp, t('txt_remote_sync_list_failed')));
  const data = await parseJson<{ data?: RemoteSyncSourceRecord[] }>(resp);
  return data?.data ?? [];
}

export async function createRemoteSyncSource(
  authedFetch: AuthedFetch,
  payload: { url: string; email: string; masterPassword: string; syncIntervalMinutes: number }
): Promise<RemoteSyncSourceResponse> {
  const resp = await authedFetch('/api/admin/remote-sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await parseJson<RemoteSyncSourceResponse>(resp);
  if (!resp.ok) {
    const error = json?.syncResult?.error || (await parseErrorMessage(resp, t('txt_remote_sync_create_failed')));
    throw new Error(error);
  }
  return json as RemoteSyncSourceResponse;
}

export async function updateRemoteSyncSource(
  authedFetch: AuthedFetch,
  id: string,
  payload: { syncIntervalMinutes?: number; enabled?: boolean; masterPassword?: string }
): Promise<RemoteSyncSourceResponse> {
  const resp = await authedFetch(`/api/admin/remote-sync/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await parseJson<RemoteSyncSourceResponse>(resp);
  if (!resp.ok) {
    const error = json?.syncResult?.error || (await parseErrorMessage(resp, t('txt_remote_sync_update_failed')));
    throw new Error(error);
  }
  return json as RemoteSyncSourceResponse;
}

export async function triggerRemoteSyncSource(authedFetch: AuthedFetch, id: string): Promise<RemoteSyncSourceResponse> {
  const resp = await authedFetch(`/api/admin/remote-sync/${id}/trigger`, { method: 'POST' });
  const json = await parseJson<RemoteSyncSourceResponse>(resp);
  if (!resp.ok) {
    const error = json?.syncResult?.error || (await parseErrorMessage(resp, t('txt_remote_sync_trigger_failed')));
    throw new Error(error);
  }
  return json as RemoteSyncSourceResponse;
}

export async function deleteRemoteSyncSource(authedFetch: AuthedFetch, id: string): Promise<void> {
  const resp = await authedFetch(`/api/admin/remote-sync/${id}`, { method: 'DELETE' });
  if (!resp.ok) throw new Error(await parseErrorMessage(resp, t('txt_remote_sync_delete_failed')));
}
