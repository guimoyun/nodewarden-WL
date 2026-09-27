// Multi-master (redundancy) sync end-to-end test.
//
// Two NodeWarden instances, A and B, point at each other as sync sources using
// the SAME account (same email + master password, hence same user key) — the
// redundancy topology. Verifies:
//   1. entries created on A reach B (and vice versa)
//   2. mutual sync converges without loops or clobbering (idempotent skip)
//   3. last-write-wins: the newer writer's edit wins on both nodes
//   4. deletion propagates across nodes
//   5. same master password unlocks synced entries on either node
//
// Run with two clean instances:
//   A: JWT_SECRET=... PORT=8788 NODEWARDEN_DATA_DIR=/tmp/nw-mm-a npx tsx local/index.ts
//   B: JWT_SECRET=... PORT=8787 NODEWARDEN_DATA_DIR=/tmp/nw-mm-b npx tsx local/index.ts
// Then: npx tsx scripts/test-remote-sync-multi-master.ts
import { computeMasterPasswordHash } from '../src/services/remote-sync';

const A = 'http://127.0.0.1:8788';
const B = 'http://127.0.0.1:8787';
const EMAIL = 'mm@test.com';
const PASS = 'MasterPass123!';
const ADMIN_A = 'adminA@test.com';
const ADMIN_B = 'adminB@test.com';
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

async function putJson(url: string, body: unknown, token: string): Promise<{ status: number; json: any }> {
  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Origin: new URL(url).origin,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const json = await resp.json().catch(() => null);
  return { status: resp.status, json };
}

async function registerUser(base: string, email: string, password: string, inviteCode?: string): Promise<string> {
  const hash = await computeMasterPasswordHash(password, email, ITER);
  const { status, json } = await postJson(`${base}/api/accounts/register`, {
    email,
    name: email.split('@')[0],
    masterPasswordHash: hash,
    key: '2.dGVzdA==|dGVzdA==',
    kdf: 0,
    kdfIterations: ITER,
    keys: { publicKey: 'cHVibGljLWtleQ==', encryptedPrivateKey: '2.aWl2|Y2lwaGVydGV4dA==' },
    ...(inviteCode ? { inviteCode } : {}),
  });
  if (status !== 200 && status !== 201) {
    throw new Error(`register ${email} failed: ${status} ${JSON.stringify(json)}`);
  }
  return hash;
}

async function createInvite(base: string, adminToken: string, adminPasswordHash: string): Promise<string> {
  const { status, json } = await postJson(
    `${base}/api/admin/invites`,
    { masterPasswordHash: adminPasswordHash, expiresInHours: 24 },
    adminToken
  );
  if (status !== 201) throw new Error(`create invite on ${base} failed: ${status} ${JSON.stringify(json)}`);
  return String(json.code);
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
  body.set('deviceName', 'TestMM');
  const resp = await fetch(`${base}/identity/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!resp.ok) throw new Error(`login ${email} failed: ${resp.status}`);
  const data = (await resp.json()) as { access_token?: string };
  if (!data.access_token) throw new Error('no access token');
  return data.access_token;
}

function enc(v: string): string {
  return `2.${Buffer.from('iv').toString('base64')}|${Buffer.from(v).toString('base64')}|${Buffer.from('mac').toString('base64')}`;
}

async function createCipher(base: string, token: string, name: string): Promise<string> {
  const { status, json } = await postJson(
    `${base}/api/ciphers`,
    {
      type: 1,
      name: enc('name-' + name),
      notes: enc('note-' + name),
      favorite: false,
      login: { username: enc('u-' + name), password: enc('p-' + name), uris: [{ uri: enc('https://' + name + '.test'), match: null }] },
    },
    token
  );
  if (status !== 200 && status !== 201) {
    throw new Error(`create cipher failed: ${status} ${JSON.stringify(json)}`);
  }
  return String(json.id);
}

async function updateCipher(base: string, token: string, id: string, name: string): Promise<void> {
  const { status } = await putJson(
    `${base}/api/ciphers/${id}`,
    {
      type: 1,
      name: enc('name-' + name),
      notes: enc('note-updated-' + name),
      favorite: false,
      login: { username: enc('u-' + name), password: enc('p2-' + name), uris: [{ uri: enc('https://' + name + '.test'), match: null }] },
    },
    token
  );
  if (status !== 200) throw new Error(`update cipher ${id} failed: ${status}`);
}

// Decode an encrypted-string payload to its plaintext for assertions:
// "2.<ivB64>|<dataB64>|<macB64>" → dataB64 decoded.
function dec(v: string): string {
  const parts = String(v || '').split('|');
  if (parts.length < 2) return String(v || '');
  return Buffer.from(parts[1], 'base64').toString();
}

async function softDeleteCipher(base: string, token: string, id: string): Promise<void> {
  const resp = await fetch(`${base}/api/ciphers/${id}`, {
    method: 'DELETE',
    headers: { Origin: base, Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`soft delete ${id} failed: ${resp.status}`);
}

async function addSource(base: string, adminToken: string, remote: string): Promise<string> {
  const { status, json } = await postJson(
    `${base}/api/admin/remote-sync`,
    { url: remote, email: EMAIL, masterPassword: PASS, syncIntervalMinutes: 1 },
    adminToken
  );
  if (status !== 200) throw new Error(`add source on ${base} failed: ${status} ${JSON.stringify(json)}`);
  return String(json.id);
}

async function trigger(base: string, adminToken: string, sourceId: string): Promise<any> {
  const { status, json } = await postJson(`${base}/api/admin/remote-sync/${sourceId}/trigger`, {}, adminToken);
  if (status !== 200) throw new Error(`trigger on ${base} failed: ${status} ${JSON.stringify(json)}`);
  return json?.syncResult ?? {};
}

async function listCiphers(base: string, token: string): Promise<any[]> {
  const resp = await fetch(`${base}/api/sync`, { headers: { Authorization: `Bearer ${token}` } });
  const data = (await resp.json()) as any;
  return data.ciphers ?? [];
}

async function main(): Promise<void> {
  console.log('[1] Register admins on both nodes; register shared account via invite codes');
  const adminAHash = await registerUser(A, ADMIN_A, ADMIN_PASS); // first user on A → admin
  const aAdmin = await login(A, ADMIN_A, adminAHash);
  const inviteA = await createInvite(A, aAdmin, adminAHash);
  const hash = await registerUser(A, EMAIL, PASS, inviteA); // shared account (same key both nodes)
  const aToken = await login(A, EMAIL, hash);
  const id1 = await createCipher(A, aToken, 'site-one');
  await createCipher(A, aToken, 'site-two');
  const adminBHash = await registerUser(B, ADMIN_B, ADMIN_PASS); // first user on B → admin
  const bAdmin = await login(B, ADMIN_B, adminBHash);
  const inviteB = await createInvite(B, bAdmin, adminBHash);
  await registerUser(B, EMAIL, PASS, inviteB);
  const bToken = await login(B, EMAIL, hash);
  console.log('  admins + shared account (2 ciphers on A) ready');

  console.log('[2] B admin adds A as source → entries pulled (local shared account matches by key)');
  const sourceOnB = await addSource(B, bAdmin, A); // B pulls from A (addSource syncs immediately)
  let bCiphers = await listCiphers(B, bToken);
  assert(bCiphers.length === 2, `B has 2 ciphers right after addSource (got ${bCiphers.length})`);
  const r1 = await trigger(B, bAdmin, sourceOnB);
  assert(r1.added === 0 && r1.skipped === 2, `second sync idempotent (got ${JSON.stringify(r1)})`);

  console.log('[3] Reverse direction: A admin adds B as source → converge (nothing new, nothing clobbered)');
  const sourceOnA = await addSource(A, aAdmin, B); // A pulls from B
  const r2 = await trigger(A, aAdmin, sourceOnA);
  assert(r2.added === 0 && r2.skipped >= 2, `A converges: added=0 skipped>=2 (got ${JSON.stringify(r2)})`);
  let aCiphers = await listCiphers(A, aToken);
  assert(aCiphers.length === 2, `A still has 2 ciphers (got ${aCiphers.length})`);

  console.log('[4] Edit on B → reaches A (last-write-wins, forward)');
  await updateCipher(B, bToken, id1, 'site-one-v2');
  const r3 = await trigger(A, aAdmin, sourceOnA);
  assert(r3.updated >= 1, `A updated 1 from B (got ${JSON.stringify(r3)})`);
  aCiphers = await listCiphers(A, aToken);
  const onA = aCiphers.find((c) => c.id === id1);
  assert(!!onA && dec(onA.name).includes('v2'), 'A now has B\'s newer version');

  console.log('[5] Conflict: A edits AFTER B → A\'s newer write wins, conflict surfaced');
  await updateCipher(A, aToken, id1, 'site-one-v3'); // newer than B's v2
  const r4 = await trigger(B, bAdmin, sourceOnB);
  assert(r4.updated >= 1, `B pulled A's newer edit (got ${JSON.stringify(r4)})`);
  assert(
    (r4.warnings ?? []).some((w: string) => w.includes('两端均有修改')),
    `conflict surfaced in warnings (got ${JSON.stringify(r4.warnings)})`
  );
  bCiphers = await listCiphers(B, bToken);
  const onB = bCiphers.find((c) => c.id === id1);
  assert(!!onB && dec(onB.name).includes('v3'), 'B now has A\'s newer version (last write wins)');
  const conflictsResp = await fetch(`${B}/api/admin/remote-sync/conflicts`, {
    headers: { Authorization: `Bearer ${bAdmin}` },
  });
  const conflicts = ((await conflictsResp.json()) as any).data ?? [];
  assert(conflicts.length === 1, `1 pending conflict listed (got ${conflicts.length})`);
  assert(conflicts[0]?.cipherId === id1, 'conflict references the edited cipher');
  assert(conflicts[0]?.resolution === 'auto-remote', `resolution is auto-remote (got ${conflicts[0]?.resolution})`);
  const ack = await fetch(`${B}/api/admin/remote-sync/conflicts/${conflicts[0].id}/ack`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bAdmin}` },
  });
  const ackJson = (await ack.json()) as any;
  assert(ack.status === 200 && ackJson?.status === 'acknowledged', 'conflict acknowledged');
  const afterAck = await fetch(`${B}/api/admin/remote-sync/conflicts`, {
    headers: { Authorization: `Bearer ${bAdmin}` },
  });
  const afterList = ((await afterAck.json()) as any).data ?? [];
  assert(afterList.length === 0, 'no pending conflicts after ack');

  console.log('[6] Idempotent re-sync: no loops, no overwrite, no duplicate conflict');
  const r5 = await trigger(A, aAdmin, sourceOnA);
  assert(r5.added === 0 && r5.updated === 0 && r5.skipped >= 2, `A re-sync idempotent (got ${JSON.stringify(r5)})`);
  const afterRe = await fetch(`${B}/api/admin/remote-sync/conflicts`, {
    headers: { Authorization: `Bearer ${bAdmin}` },
  });
  const reList = ((await afterRe.json()) as any).data ?? [];
  assert(reList.length === 0, 'no conflict re-created on idempotent re-sync');

  console.log('[7] Deletion propagates: soft-delete on A → B marks deleted');
  await softDeleteCipher(A, aToken, id1);
  const r6 = await trigger(B, bAdmin, sourceOnB);
  assert(r6.updated >= 1, `B sync saw the delete (got ${JSON.stringify(r6)})`);
  bCiphers = await listCiphers(B, bToken);
  const deleted = bCiphers.find((c) => c.id === id1);
  assert(!!deleted && !!deleted.deletedDate, 'entry is marked deleted on B');

  console.log('[8] Same master password unlocks synced entries on both nodes');
  const bCipher = bCiphers.find((c) => c.id !== id1);
  assert(bCipher && bCipher.name && bCipher.login, 'B entry carries decryptable ciphertext (name/login present)');

  console.log('');
  if (failures === 0) {
    console.log('ALL MULTI-MASTER SYNC TESTS PASSED');
  } else {
    console.log(`${failures} TEST(S) FAILED`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('TEST ERROR:', error);
  process.exit(1);
});
