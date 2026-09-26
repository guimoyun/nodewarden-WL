// Scheduled remote-sync verification.
// Adds a source to B, rewinds its lastSyncAt to the past, runs
// runScheduledRemoteSyncIfDue, and asserts the sync actually fires.
// Requires A (8788) and B (8787) running with clean data.
// Run: npx tsx scripts/test-remote-sync-schedule.ts
import { computeMasterPasswordHash, runScheduledRemoteSyncIfDue } from '../src/services/remote-sync';
import { createLocalEnv } from '../local/env';

const A = 'http://127.0.0.1:8788';
const B = 'http://127.0.0.1:8787';
const REMOTE_EMAIL = 'usera@test.com';
const REMOTE_PASS = 'MasterPass123!';
const ITER = 600000;

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) console.log('  PASS', label);
  else {
    console.log('  FAIL', label);
    failures += 1;
  }
}

async function postJson(url: string, body: unknown, token?: string): Promise<{ status: number; json: any }> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: new URL(url).origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = await resp.json().catch(() => null);
  return { status: resp.status, json };
}

async function login(base: string, email: string, passwordHash: string): Promise<string> {
  const body = new URLSearchParams();
  body.set('grant_type', 'password');
  body.set('username', email);
  body.set('password', passwordHash);
  body.set('scope', 'api offline_access');
  body.set('client_id', 'web');
  body.set('deviceType', '14');
  body.set('deviceIdentifier', crypto.randomUUID());
  body.set('deviceName', 'TestSchedule');
  const resp = await fetch(`${base}/identity/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = (await resp.json()) as { access_token?: string };
  if (!data.access_token) throw new Error('login failed');
  return data.access_token;
}

async function main(): Promise<void> {
  const bundle = await createLocalEnv({
    dataDir: '/tmp/nw-b',
    distDir: '/home/user/Doubao/chats/38442505525906690/nodewarden/dist',
    jwtSecret: 'test-secret-b-bbbbbbbbbbbbbbbbbbbbbbbbb',
    host: '127.0.0.1',
    port: 8787,
  });
  const env = bundle.env;
  const storage = new (await import('../src/services/storage')).StorageService(env.DB as never);

  const hash = await computeMasterPasswordHash(REMOTE_PASS, REMOTE_EMAIL, ITER);
  const bToken = await login(B, REMOTE_EMAIL, hash);

  // Admin token for B (badmin@test.com / AdminPass456! registered by prior test).
  const adminHash = await computeMasterPasswordHash('AdminPass456!', 'badmin@test.com', ITER);
  const bAdminToken = await login(B, 'badmin@test.com', adminHash);

  const add = await postJson(
    `${B}/api/admin/remote-sync`,
    { url: A, email: REMOTE_EMAIL, masterPassword: REMOTE_PASS, syncIntervalMinutes: 1 },
    bAdminToken
  );
  assert(add.status === 200, `source added (${add.status})`);
  const sourceId = add.json?.id;

  // Rewind lastSyncAt so the scheduler considers it due.
  const src = await storage.getRemoteSyncSource(sourceId);
  assert(!!src, 'source persisted');
  const old = src!;
  await storage.saveRemoteSyncSource({ ...old, lastSyncAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() });

  // Run the scheduler (should trigger sync for the due source).
  await runScheduledRemoteSyncIfDue(env);

  const after = await storage.getRemoteSyncSource(sourceId);
  assert(!!after?.lastSyncAt, 'lastSyncAt updated by scheduler');
  const parsed = after!.lastResult ? JSON.parse(after!.lastResult) : null;
  assert(parsed?.ok === true, `scheduled sync ok (${JSON.stringify(parsed)})`);
  assert(parsed?.updated === 3, `3 ciphers present (got ${parsed?.updated})`);

  // Disabled source should be skipped.
  await storage.saveRemoteSyncSource({ ...after!, enabled: false });
  const beforeDisabled = await storage.getRemoteSyncSource(sourceId);
  await runScheduledRemoteSyncIfDue(env);
  const afterDisabled = await storage.getRemoteSyncSource(sourceId);
  assert(beforeDisabled!.lastSyncAt === afterDisabled!.lastSyncAt, 'disabled source skipped');

  console.log('');
  if (failures === 0) console.log('SCHEDULED REMOTE-SYNC TESTS PASSED');
  else {
    console.log(`${failures} TEST(S) FAILED`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('TEST ERROR:', error);
  process.exit(1);
});
