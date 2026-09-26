import type { Env, User } from './types';
import {
  handleListRemoteSyncSources,
  handleCreateRemoteSyncSource,
  handleUpdateRemoteSyncSource,
  handleDeleteRemoteSyncSource,
  handleTriggerRemoteSyncSource,
} from './handlers/remote-sync-admin';

export async function handleAdminRemoteSyncRoute(
  request: Request,
  env: Env,
  actorUser: User,
  path: string,
  method: string
): Promise<Response | null> {
  if (path === '/api/admin/remote-sync' && method === 'GET') {
    return handleListRemoteSyncSources(request, env, actorUser);
  }

  if (path === '/api/admin/remote-sync' && method === 'POST') {
    return handleCreateRemoteSyncSource(request, env, actorUser);
  }

  const itemMatch = path.match(/^\/api\/admin\/remote-sync\/([a-f0-9-]+)(?:\/(trigger))?$/i);
  if (itemMatch) {
    const sourceId = itemMatch[1];
    const subAction = itemMatch[2];

    if (subAction === 'trigger' && method === 'POST') {
      return handleTriggerRemoteSyncSource(request, env, actorUser, sourceId);
    }

    if (method === 'PUT') {
      return handleUpdateRemoteSyncSource(request, env, actorUser, sourceId);
    }

    if (method === 'DELETE') {
      return handleDeleteRemoteSyncSource(request, env, actorUser, sourceId);
    }

    return null;
  }

  return null;
}
