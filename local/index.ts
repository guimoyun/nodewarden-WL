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

const BACKUP_INTERVAL_MS = 5 * 60 * 1000;

async function main(): Promise<void> {
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

  const shutdown = async () => {
    console.log('\n[nodewarden-local] shutting down...');
    clearInterval(timer);
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
