/** "What's on your mind?" posts on the shop's Facebook page, against a real database. Needs DATABASE_URL. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { agents, channels, createDb, memberships, pagePosts, sessions, users, workspaces, type Db } from '@agently/db';
import { GraphApiError } from '@agently/meta';
import { encryptSecret } from '@agently/shared';
import { buildServer } from '../server.ts';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL not set';
const key = randomBytes(32).toString('base64');
const WEB = 'https://app.agently.test';
const FILES = 'https://files.agently.test';
let db: Db;
let close: () => Promise<void>;

before(() => {
  if (!skip) ({ db, close } = createDb(url!, { max: 4 }));
});
after(async () => {
  if (!skip) await close();
});

type Call = { kind: 'post' | 'video'; pageId: string; message: string; photoUrls?: string[]; fileUrl?: string };

function server(fail?: GraphApiError) {
  const calls: Call[] = [];
  let n = 0;
  const app = buildServer({
    db,
    redis: { ping: async () => 'PONG' },
    inbound: { add: async () => {} },
    meta: { appSecret: 's', verifyToken: 'v' },
    facebook: {} as never,
    graph: {
      sendText: async () => ['mid'],
      replyToComment: async () => 'cid',
      publishPost: async (_token, pageId, post) => {
        if (fail) throw fail;
        calls.push({ kind: 'post', pageId, message: post.message, photoUrls: post.photoUrls });
        return `${pageId}_${++n}`;
      },
      publishVideo: async (_token, pageId, video) => {
        if (fail) throw fail;
        calls.push({ kind: 'video', pageId, message: video.description, fileUrl: video.fileUrl });
        return `video${++n}`;
      },
    },
    encryptionKey: key,
    urls: { web: WEB, api: 'https://api.agently.test' },
    cookies: { secure: true },
    enqueueKnowledge: async () => {},
    publicFileUrl: (k: string) => `${FILES}/${k}`,
  });
  return { app, calls };
}

async function shop(role: 'owner' | 'agent' = 'owner') {
  const [ws] = await db.insert(workspaces).values({ name: 'Banggii', status: 'active' }).returning();
  await db.insert(agents).values({ workspaceId: ws!.id, name: 'Assistant' });
  const [user] = await db.insert(users).values({ name: 'Owner' }).returning();
  await db.insert(memberships).values({ workspaceId: ws!.id, userId: user!.id, role });
  const token = randomBytes(16).toString('hex');
  await db.insert(sessions).values({ userId: user!.id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 864e5) });
  const pageId = `page-${randomBytes(4).toString('hex')}`;
  const [page] = await db
    .insert(channels)
    .values({ workspaceId: ws!.id, type: 'facebook_page', externalId: pageId, name: 'Banggii.com', accessTokenEncrypted: encryptSecret('page-token', key) })
    .returning();
  return { ws: ws!, page: page!, auth: { cookies: { agently_session: token }, headers: { origin: WEB } } };
}

test('page posts: text, photos together, or one video; listed newest first', { skip }, async () => {
  const { app, calls } = server();
  const { ws, page, auth } = await shop();
  const path = `/api/workspaces/${ws.id}/page-posts`;
  const file = (name: string) => `${FILES}/${ws.id}/images/${name}`;
  const post = (payload: object) => app.inject({ method: 'POST', url: path, payload, ...auth });

  const text = await post({ message: 'Eid Mubarak from Banggii!' });
  assert.equal(text.statusCode, 201, text.body);
  assert.equal(text.json().post.url, `https://www.facebook.com/${page.externalId}_1`);

  const photos = await post({ message: 'New arrivals', photoUrls: [file('a.jpg'), file('b.jpg')] });
  assert.equal(photos.statusCode, 201, photos.body);
  const video = await post({ message: 'Watch this', videoUrl: `${FILES}/${ws.id}/videos/v.mp4` });
  assert.equal(video.statusCode, 201, video.body);
  assert.equal(video.json().post.url, `https://www.facebook.com/${page.externalId}/videos/video3`);

  assert.deepEqual(calls, [
    { kind: 'post', pageId: page.externalId, message: 'Eid Mubarak from Banggii!', photoUrls: [] },
    { kind: 'post', pageId: page.externalId, message: 'New arrivals', photoUrls: [file('a.jpg'), file('b.jpg')] },
    { kind: 'video', pageId: page.externalId, message: 'Watch this', fileUrl: `${FILES}/${ws.id}/videos/v.mp4` },
  ]);
  const list = (await app.inject({ url: path, ...auth })).json().posts;
  assert.deepEqual(list.map((p: { postId: string }) => p.postId), ['video3', `${page.externalId}_2`, `${page.externalId}_1`]);
});

test('page posts: refuses empty posts, photos with a video, files from elsewhere, and staff', { skip }, async () => {
  const { app, calls } = server();
  const { ws, auth } = await shop();
  const other = await shop();
  const path = `/api/workspaces/${ws.id}/page-posts`;
  const post = (payload: object) => app.inject({ method: 'POST', url: path, payload, ...auth });

  assert.equal((await post({ message: '  ' })).statusCode, 400);
  assert.equal((await post({ photoUrls: [`${FILES}/${ws.id}/images/a.jpg`], videoUrl: `${FILES}/${ws.id}/videos/v.mp4` })).statusCode, 400);
  assert.equal((await post({ photoUrls: ['https://evil.test/x.jpg'] })).statusCode, 400);
  // Another shop's upload is not this shop's to post.
  assert.equal((await post({ videoUrl: `${FILES}/${other.ws.id}/videos/v.mp4` })).statusCode, 400);

  const staff = await shop('agent');
  const denied = await app.inject({ method: 'POST', url: `/api/workspaces/${staff.ws.id}/page-posts`, payload: { message: 'Hi' }, ...staff.auth });
  assert.equal(denied.statusCode, 403);
  assert.equal(calls.length, 0);
});

test('page posts: a revoked page token marks the page for reconnecting', { skip }, async () => {
  const { app } = server(new GraphApiError('Session expired', 400, 190));
  const { ws, page, auth } = await shop();
  const res = await app.inject({ method: 'POST', url: `/api/workspaces/${ws.id}/page-posts`, payload: { message: 'Hi' }, ...auth });
  assert.equal(res.statusCode, 409);
  assert.equal((await db.select().from(channels).where(eq(channels.id, page.id)))[0]!.status, 'token_expired');
  assert.equal((await db.select().from(pagePosts).where(eq(pagePosts.workspaceId, ws.id))).length, 0);
});
