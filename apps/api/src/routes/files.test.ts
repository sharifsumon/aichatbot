/** Product photos on the server's disk: stored by the upload route, served at /files. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskStore, storageFromEnv, workspaceKey } from '@agently/storage';
import { buildServer } from '../server.ts';

const WS = '00000000-0000-4000-8000-000000000001';

function server(store: DiskStore) {
  return buildServer({
    db: {} as never,
    redis: { ping: async () => 'PONG' },
    inbound: { add: async () => {} },
    meta: { appSecret: 's', verifyToken: 'v' },
    facebook: {} as never,
    graph: {} as never,
    encryptionKey: 'k',
    urls: { web: 'https://app.test', api: 'https://api.test' },
    cookies: { secure: true },
    enqueueKnowledge: async () => {},
    storage: store,
    diskFiles: store,
    publicFileUrl: (k) => `https://api.test/files/${k}`,
  });
}

test('disk store: put, get, delete, and keys cannot leave the folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agently-files-'));
  try {
    const store = new DiskStore(dir);
    const key = workspaceKey(WS, 'knowledge', 'a.pdf');
    await store.put(key, new Uint8Array([1, 2, 3]), 'application/pdf');
    assert.deepEqual([...(await store.get(key))], [1, 2, 3]);
    await store.delete(key);
    await assert.rejects(store.get(key));
    await store.delete(key); // deleting twice is fine
    for (const bad of ['../x', `${WS}/../../etc/passwd`, '/etc/passwd', `${WS}/./a`, '', `${WS}//a`]) {
      assert.equal(store.pathOf(bad), undefined, bad);
      await assert.rejects(store.put(bad, new Uint8Array([1]), 'x'), bad);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('storage from env: S3 wins, then FILES_DIR, else none', () => {
  assert.equal(storageFromEnv({}), undefined);
  assert.ok(storageFromEnv({ FILES_DIR: '/tmp/x' }) instanceof DiskStore);
  assert.ok(!(storageFromEnv({ FILES_DIR: '/tmp/x', S3_ENDPOINT: 'https://s3.test', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 's' }) instanceof DiskStore));
  assert.throws(() => storageFromEnv({ S3_ENDPOINT: 'https://s3.test' }));
});

test('files route: serves stored product photos; nothing else', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agently-files-'));
  try {
    const store = new DiskStore(dir);
    const app = server(store);
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);
    await store.put(workspaceKey(WS, 'images', 'p.jpg'), jpg, 'image/jpeg');
    await store.put(workspaceKey(WS, 'knowledge', 'secret.pdf'), new Uint8Array([1]), 'application/pdf');
    await store.put(workspaceKey(WS, 'images', 'note.pdf'), new Uint8Array([1]), 'application/pdf');

    const ok = await app.inject({ method: 'GET', url: `/files/${WS}/images/p.jpg` });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers['content-type'], 'image/jpeg');
    assert.match(String(ok.headers['cache-control']), /immutable/);
    assert.deepEqual([...ok.rawPayload], [...jpg]);

    for (const url of [
      `/files/${WS}/images/missing.jpg`,
      `/files/${WS}/knowledge/secret.pdf`,
      `/files/${WS}/images/note.pdf`,
      `/files/${WS}/images/..%2F..%2Fknowledge%2Fsecret.pdf`,
      `/files/..%2F..%2Fetc/images/passwd.jpg`,
    ]) {
      assert.equal((await app.inject({ method: 'GET', url })).statusCode, 404, url);
    }
    await app.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
