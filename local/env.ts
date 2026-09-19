// Local environment construction: builds the `Env` object NodeWarden expects
// from local configuration (data directory, dist directory, secrets).

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Env } from '../src/types';
import { LocalD1Database } from './d1';
import { LocalR2Bucket } from './r2';
import { LocalKVNamespace } from './kv';
import { LocalAssets } from './assets';
import { LocalDurableObjectNamespace, LocalDurableObjectState } from './durable';
import { NotificationsHub } from '../src/durable/notifications-hub';
import { BackupTransferRunner } from '../src/durable/backup-transfer-runner';

export interface LocalConfig {
  dataDir: string;
  distDir: string;
  jwtSecret: string;
  host: string;
  port: number;
  webauthnRpId?: string;
  webauthnRpName?: string;
  webauthnAllowedOrigins?: string;
  hideWebVault?: boolean;
}

export function parseLocalConfig(): LocalConfig {
  const baseDir = path.resolve(process.env.NODEWARDEN_DATA_DIR || path.join(process.cwd(), 'nw-data'));
  const distDir = path.resolve(process.env.NODEWARDEN_DIST_DIR || path.join(process.cwd(), 'dist'));
  const jwtSecret = process.env.JWT_SECRET || (() => {
    if (process.env.NODEWARDEN_ALLOW_INSECURE_JWT === '1') {
      const generated = randomBytes(48).toString('hex');
      console.warn('[nodewarden-local] JWT_SECRET not set; using a generated in-memory secret. Sessions will reset on restart. Set JWT_SECRET for persistence.');
      return generated;
    }
    throw new Error('JWT_SECRET is required. Set the JWT_SECRET environment variable (32+ random chars).');
  })();

  return {
    dataDir: baseDir,
    distDir,
    jwtSecret,
    host: process.env.HOST || '0.0.0.0',
    port: Number(process.env.PORT || 8787),
    webauthnRpId: process.env.WEBAUTHN_RP_ID || undefined,
    webauthnRpName: process.env.WEBAUTHN_RP_NAME || undefined,
    webauthnAllowedOrigins: process.env.WEBAUTHN_ALLOWED_ORIGINS || undefined,
    hideWebVault: process.env.HIDE_WEB_VAULT === '1',
  };
}

export interface LocalEnvBundle {
  env: Env;
  dbPath: string;
  notificationsHub: { fetch(request: Request): Promise<Response>; ctx: LocalDurableObjectState };
  backupRunner: { fetch(request: Request): Promise<Response>; ctx: LocalDurableObjectState };
}

export async function createLocalEnv(config: LocalConfig): Promise<LocalEnvBundle> {
  await fs.mkdir(path.join(config.dataDir, 'attachments'), { recursive: true });
  await fs.mkdir(path.join(config.dataDir, 'kv'), { recursive: true });

  const dbPath = path.join(config.dataDir, 'nodewarden.db');
  const db = new LocalD1Database(dbPath);
  const attachments = new LocalR2Bucket(path.join(config.dataDir, 'attachments'));
  const attachmentsKv = new LocalKVNamespace(path.join(config.dataDir, 'kv'));
  const assets = new LocalAssets(config.distDir);

  const notificationsHubState = new LocalDurableObjectState();
  const backupRunnerState = new LocalDurableObjectState();

  const notificationsHubFactory = () => {
    const hub = new NotificationsHub(notificationsHubState, env);
    return { fetch: (request: Request) => hub.fetch(request), ctx: notificationsHubState };
  };
  const backupRunnerFactory = () => {
    const runner = new BackupTransferRunner(backupRunnerState as never, env);
    return { fetch: (request: Request) => runner.fetch(request), ctx: backupRunnerState };
  };

  const env: Env = {
    DB: db as never,
    NOTIFICATIONS_HUB: new LocalDurableObjectNamespace(notificationsHubFactory) as never,
    BACKUP_TRANSFER_RUNNER: new LocalDurableObjectNamespace(backupRunnerFactory) as never,
    ASSETS: assets as never,
    ATTACHMENTS: attachments as never,
    ATTACHMENTS_KV: attachmentsKv as never,
    JWT_SECRET: config.jwtSecret,
    HIDE_WEB_VAULT: config.hideWebVault ? '1' : undefined,
    WEBAUTHN_RP_ID: config.webauthnRpId,
    WEBAUTHN_RP_NAME: config.webauthnRpName,
    WEBAUTHN_ALLOWED_ORIGINS: config.webauthnAllowedOrigins,
  };

  const bundle: LocalEnvBundle = {
    env,
    dbPath,
    notificationsHub: { fetch: notificationsHubFactory().fetch, ctx: notificationsHubState },
    backupRunner: { fetch: backupRunnerFactory().fetch, ctx: backupRunnerState },
  };
  return bundle;
}
