// Remote sync end-to-end smoke test.
// Requires two local instances: A = remote source (port 8788), B = sync target (port 8787).
// Run: npx tsx scripts/test-remote-sync.ts
import { computeMasterPasswordHash } from '../src/services/remote-sync';

const A = 'http://127.0.0.1:8788';
const B = 'http://127.0.0.1:8787';
const REMOTE_EMAIL = 'usera@test.com';
const REMOTE_PASS = 'MasterPass123!';
const ADMIN_EMAIL = 'badmin@test.com';
const ADMIN_PASS = 'AdminPass456!';
const ITER = 600000;

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    console.log('  PASS', label);
  } else {
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

async function registerUser(base: string, email: string, password: string): Promise<string> {
  const hash = await computeMasterPasswordHash(password, email, ITER);
  const { status, json } = await postJson(`${base}/api/accounts/register`, {
    email,
    name: email.split('@')[0],
    masterPasswordHash: hash,
    key: '2.dGVzdA==|dGVzdA==',
    kdf: 0,
    kdfIterations: ITER,
    keys: { publicKey: 'cHVibGljLWtleQ==', encryptedPrivateKey: '2.aWl2|Y2lwaGVydGV4dA==' },
  });
  if (status !== 200 && status !== 201) {
    throw new Error(`register ${email} failed: ${status} ${JSON.stringify(json)}`);
  }
  return hash;
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
  body.set('deviceName', 'TestSync');
  const resp = await fetch(`${base}/identity/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!resp.ok) {
    throw new Error(`login ${email} failed: ${resp.status}`);
  }
  const data = (await resp.json()) as { access_token?: string };
  if (!data.access_token) throw new Error('no access token');
  return data.access_token;
}

function enc(v: string): string {
  return `2.${Buffer.from('iv').toString('base64')}|${Buffer.from(v).toString('base64')}|${Buffer.from('mac').toString('base64')}`;
}

async function createCipher(base: string, token: string, name: string, username: string): Promise<void> {
  const { status, json } = await postJson(
    `${base}/api/ciphers`,
    {
      type: 1,
      name: enc('name-' + name),
      notes: enc('note-' + name),
      favorite: false,
      login: { username: enc(username), password: enc('p-' + name), uris: [{ uri: enc('https://' + name + '.test'), match: null }] },
    },
    token
  );
  if (status !== 200 && status !== 201) {
    throw new Error(`create cipher failed: ${status} ${JSON.stringify(json)}`);
  }
}

async function main(): Promise<void> {
  console.log('[1] Register remote user on A and create 2 ciphers');
  const remoteHash = await registerUser(A, REMOTE_EMAIL, REMOTE_PASS);
  const aToken = await login(A, REMOTE_EMAIL, remoteHash);
  await createCipher(A, aToken, 'site-one', 'user1');
  await createCipher(A, aToken, 'site-two', 'user2');
  console.log('  created on A');

  console.log('[2] Register admin on B');
  const adminHash = await registerUser(B, ADMIN_EMAIL, ADMIN_PASS);
  const bAdminToken = await login(B, ADMIN_EMAIL, adminHash);
  console.log('  admin ready');

  console.log('[3] Add remote sync source on B (admin API)');
  const { status, json } = await postJson(
    `${B}/api/admin/remote-sync`,
    {
      url: A,
      email: REMOTE_EMAIL,
      masterPassword: REMOTE_PASS,
      syncIntervalMinutes: 5,
    },
    bAdminToken
  );
  assert(status === 200, `POST /api/admin/remote-sync status ${status}`);
  assert(json?.syncResult?.ok === true, `initial sync ok (got ${JSON.stringify(json?.syncResult)})`);
  assert(json?.syncResult?.added === 2, `added 2 ciphers (got ${json?.syncResult?.added})`);
  assert(json?.syncResult?.folders === 0, `folders 0`);

  console.log('[4] Verify remote user can log into B and see synced ciphers');
  const bRemoteToken = await login(B, REMOTE_EMAIL, remoteHash);
  const syncResp = await fetch(`${B}/api/sync`, { headers: { Authorization: `Bearer ${bRemoteToken}` } });
  const syncData = (await syncResp.json()) as any;
  assert(syncResp.status === 200, 'sync endpoint reachable');
  assert(Array.isArray(syncData.ciphers) && syncData.ciphers.length === 2, `B has 2 ciphers (got ${syncData.ciphers?.length})`);
  assert(syncData.profile?.email === REMOTE_EMAIL, `profile email matches`);

  console.log('[5] Add a third cipher on A, then trigger sync on B');
  await createCipher(A, aToken, 'site-three', 'user3');
  const sourcesResp = await fetch(`${B}/api/admin/remote-sync`, { headers: { Authorization: `Bearer ${bAdminToken}` } });
  const sources = (await sourcesResp.json()) as any;
  const sourceId = sources.data?.[0]?.id;
  assert(!!sourceId, 'source listed');
  const trigger = await postJson(`${B}/api/admin/remote-sync/${sourceId}/trigger`, {}, bAdminToken);
  assert(trigger.json?.syncResult?.added === 1, `trigger added 1 (got ${JSON.stringify(trigger.json?.syncResult)})`);

  console.log('[6] Re-sync is idempotent (no duplicates)');
  const trigger2 = await postJson(`${B}/api/admin/remote-sync/${sourceId}/trigger`, {}, bAdminToken);
  assert(trigger2.json?.syncResult?.added === 0 && trigger2.json?.syncResult?.updated === 3, `second sync: added=0 updated=3 (got ${JSON.stringify(trigger2.json?.syncResult)})`);

  console.log('[7] Bad credentials rejected with clear error');
  const badResp = await postJson(
    `${B}/api/admin/remote-sync`,
    { url: A, email: REMOTE_EMAIL, masterPassword: 'WrongPass!', syncIntervalMinutes: 5 },
    bAdminToken
  );
  assert(badResp.status === 422 && !!badResp.json?.syncResult?.error, `bad password → 422 with error (got ${badResp.status})`);

  console.log('[8] Delete source');
  const del = await fetch(`${B}/api/admin/remote-sync/${sourceId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${bAdminToken}` },
  });
  const delJson = await del.json().catch(() => null);
  assert(del.status === 200 && delJson?.deleted === true, 'source deleted');

  console.log('');
  if (failures === 0) {
    console.log('ALL REMOTE-SYNC TESTS PASSED');
  } else {
    console.log(`${failures} TEST(S) FAILED`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('TEST ERROR:', error);
  process.exit(1);
});
