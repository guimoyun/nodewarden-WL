// Admin API for one-click self-update (Windows Web Vault settings page).
// GET  /api/admin/update/check  → version comparison against GitHub Releases
// POST /api/admin/update/apply  → download + swap binary + restart

import { jsonResponse, errorResponse } from '../utils/response';
import { checkForUpdates, applyUpdate, currentVersion } from '../services/update-checker';
import type { User } from '../types';

export async function handleUpdateCheck(): Promise<Response> {
  const result = await checkForUpdates();
  if (!result.ok) {
    return errorResponse(result.error || '检查更新失败', 502);
  }
  return jsonResponse({ object: 'update-check', ...result });
}

export async function handleUpdateApply(): Promise<Response> {
  const check = await checkForUpdates();
  if (!check.ok) {
    return errorResponse(check.error || '检查更新失败', 502);
  }
  if (!check.hasUpdate) {
    return jsonResponse({ object: 'update-apply', ok: true, message: '当前已是最新版本，无需更新', applied: false });
  }
  const outcome = await applyUpdate(check);
  return jsonResponse({
    object: 'update-apply',
    ok: outcome.ok,
    applied: outcome.ok,
    message: outcome.message,
    fromVersion: currentVersion(),
    toVersion: check.latestVersion,
  }, outcome.ok ? 200 : 500);
}

export async function handleAdminUpdateRoute(
  request: Request,
  _env: unknown,
  actorUser: User
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === '/api/admin/update/check' && request.method === 'GET') {
    return handleUpdateCheck();
  }
  if (path === '/api/admin/update/apply' && request.method === 'POST') {
    return handleUpdateApply();
  }
  return null;
}
