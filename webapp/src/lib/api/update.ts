import { t } from '../i18n';
import type { AuthedFetch } from './shared';
import { parseErrorMessage, parseJson } from './shared';

export interface UpdateCheckRecord {
  ok: boolean;
  currentVersion: string;
  latestVersion: string | null;
  hasUpdate: boolean;
  assetUrl: string | null;
  assetName: string | null;
  assetSize: number | null;
  publishedAt: string | null;
  releaseNotes: string | null;
  platform: string;
  error: string | null;
}

export async function checkUpdate(authedFetch: AuthedFetch): Promise<UpdateCheckRecord> {
  const resp = await authedFetch('/api/admin/update/check');
  if (!resp.ok) throw new Error(await parseErrorMessage(resp, t('txt_update_check_failed')));
  const data = await parseJson<UpdateCheckRecord>(resp);
  if (!data.ok) throw new Error(data.error || t('txt_update_check_failed'));
  return data;
}

export async function applyUpdate(authedFetch: AuthedFetch): Promise<{ ok: boolean; message: string; applied: boolean }> {
  const resp = await authedFetch('/api/admin/update/apply', { method: 'POST' });
  const json = await parseJson<{ ok?: boolean; message?: string; applied?: boolean }>(resp);
  if (!resp.ok || json?.ok !== true) {
    throw new Error(json?.message || (await parseErrorMessage(resp, t('txt_update_apply_failed'))));
  }
  return { ok: true, message: json.message || '', applied: json.applied !== false };
}
