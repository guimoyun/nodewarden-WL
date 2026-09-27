// NodeWarden Local — standalone executable entry point.
// Runs the Cloudflare Workers implementation on plain Node.js with:
//   - SQLite database (node:sqlite) instead of Cloudflare D1
//   - local directory storage instead of R2 / KV
//   - in-process Durable Object simulation + ws WebSocket server
//   - setInterval scheduled backups instead of CF Cron Triggers

import worker from '../src/index';
import { StorageService } from '../src/services/storage';
import { parseLocalConfig, createLocalEnv, type LocalConfig } from './env';
import { startLocalServer } from './server';
import { installLocalCaches } from './cache';
import { runScheduledBackupIfDue } from '../src/handlers/backup';
import { runScheduledRemoteSyncIfDue } from '../src/services/remote-sync';
import { installService, uninstallService, printHelp } from './service-install';

const BACKUP_INTERVAL_MS = 5 * 60 * 1000;
const REMOTE_SYNC_CHECK_INTERVAL_MS = 60 * 1000;

/** Handle --install-service / --uninstall-service / --help before starting the server. */
function handleServiceCli(): 'start' | 'exit' {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h') || args.includes('help')) {
    printHelp();
    return 'exit';
  }
  if (args.includes('--install-service')) {
    // Allow service registration even when JWT_SECRET is not set yet: the
    // installer persists a generated secret to /etc/nodewarden.env.
    if (!process.env.JWT_SECRET && !process.env.NODEWARDEN_ALLOW_INSECURE_JWT) {
      process.env.NODEWARDEN_ALLOW_INSECURE_JWT = '1';
    }
    const config: LocalConfig = parseLocalConfig();
    const outcome = installService(config);
    console.log(`[nodewarden-local] ${outcome.message}`);
    if (!outcome.ok) {
      console.log(`[nodewarden-local] 检测到 init 系统: ${outcome.init}`);
      process.exit(1);
    }
    return 'exit';
  }
  if (args.includes('--uninstall-service')) {
    // Uninstall must work even when JWT_SECRET is unset (e.g. after wiping env).
    if (!process.env.JWT_SECRET && !process.env.NODEWARDEN_ALLOW_INSECURE_JWT) {
      process.env.NODEWARDEN_ALLOW_INSECURE_JWT = '1';
    }
    const config: LocalConfig = parseLocalConfig();
    const outcome = uninstallService(config);
    console.log(`[nodewarden-local] ${outcome.message}`);
    process.exit(outcome.ok ? 0 : 1);
    return 'exit';
  }
  return 'start';
}

async function main(): Promise<void> {
  // Handle CLI commands (--install-service / --uninstall-service / --help)
  // before starting the HTTP server.
  if (handleServiceCli() === 'exit') {
    process.exit(0);
  }
  // Runtime marker so Cloudflare-only semantics can adapt (see notifications-hub.ts).
  (globalThis as { __NODEWARDEN_LOCAL__?: boolean }).__NODEWARDEN_LOCAL__ = true;
  installLocalCaches();
  const config: LocalConfig = parseLocalConfig();
  const bundle = await createLocalEnv(config);

  const { server } = startLocalServer(bundle, worker as never, { host: config.host, port: config.port });

  // Initialize the database at startup so first requests are fast and errors
  // surface immediately.
  try {
    const storage = new StorageService(bundle.env.DB as never);
    await storage.initializeDatabase();
    console.log('[nodewarden-local] database initialized');
  } catch (error) {
    console.error('[nodewarden-local] database initialization failed:', error);
    console.error('[nodewarden-local] shutting down.');
    process.exit(1);
  }

  // Scheduled backups: mirrors Cloudflare Cron Trigger (*/5 * * * *).
  const timer = setInterval(async () => {
    try {
      await runScheduledBackupIfDue(bundle.env).catch((error) => {
        console.error('[nodewarden-local] scheduled backup failed:', error);
      });
    } catch (error) {
      console.error('[nodewarden-local] scheduled backup error:', error);
    }
  }, BACKUP_INTERVAL_MS);
  timer.unref?.();

  // Scheduled remote vault sync: each source runs at its own interval.
  const remoteSyncTimer = setInterval(async () => {
    try {
      await runScheduledRemoteSyncIfDue(bundle.env).catch((error) => {
        console.error('[nodewarden-local] scheduled remote sync failed:', error);
      });
    } catch (error) {
      console.error('[nodewarden-local] scheduled remote sync error:', error);
    }
  }, REMOTE_SYNC_CHECK_INTERVAL_MS);
  remoteSyncTimer.unref?.();

  const shutdown = async () => {
    console.log('\n[nodewarden-local] shutting down...');
    clearInterval(timer);
    clearInterval(remoteSyncTimer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error) => {
  console.error('[nodewarden-local] fatal error:', error);
  process.exit(1);
});
