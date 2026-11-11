/** Videos with models (shop). Needs DATABASE_URL. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { TryOnError } from '@agently/ai';
import {
  createDb,
  creditGrants,
  memberships,
  modelCharacters,
  platformSessions,
  platformUsers,
  sessions,
  usageRecords,
  users,
  workspaces,
  type Db,
} from '@agently/db';
import { buildServer } from '../server.ts';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL not set';
const WEB = 'https://app.agently.test';
const ADMIN = 'https://admin.agently.test';
const FILES = 'https://files.agently.test/';
let db: Db;
let close: () => Promise<void>;

before(() => {
  if (!skip) ({ db, close } = createDb(url!, { max: 4 }));
});
after(async () => {
  if (!skip) await close();
});

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]);

type Calls = { speak: unknown[]; talk: unknown[]; walk: unknown[] };
function fakeVideo(fail = false) {
  const calls: Calls = { speak: [], talk: [], walk: [] };
  const video = {
    model: 'fal-ai/kling-video/ai-avatar/v2/standard',
    walkModel: 'fal-ai/kling-video/v2.6/pro/image-to-video',
    async speak(req: unknown) {
      calls.speak.push(req);
      return { audioUrl: 'https://fal.media/voice.mp3', durationSec: 6 };
    },
    async talk(req: unknown) {
      calls.talk.push(req);
      if (fail) throw new TryOnError('boom', 'The AI could not make this video: boom');
      return { video: { bytes: new Uint8Array([1, 2, 3]), contentType: 'video/mp4' }, durationSec: 6.2, costUsd: 0.35 };
    },
    async walk(req: unknown) {
      calls.walk.push(req);
      return { video: { bytes: new Uint8Array([4, 5]), contentType: 'video/mp4' }, durationSec: 5, costUsd: 0.7 };
    },
  };
  return { video, calls };
}

function server(video?: ReturnType<typeof fakeVideo>['video']) {
  const objects = new Map<string, { body: Uint8Array; type: string }>();
  const app = buildServer({
    db,
    redis: { ping: async () => 'PONG' },
    inbound: { add: async () => {} },
    meta: { appSecret: 's', verifyToken: 'v' },
    facebook: {} as never,
    graph: {} as never,
    encryptionKey: randomBytes(32).toString('base64'),
    urls: { web: WEB, api: 'https://api.agently.test', admin: ADMIN },
    cookies: { secure: true },
    enqueueKnowledge: async () => {},
    storage: {
      get: async (k) => {
        const o = objects.get(k);
        if (!o) throw new Error(`no ${k}`);
        return o.body;
      },
      put: async (k, body, type) => void objects.set(k, { body, type }),
      delete: async (k) => void objects.delete(k),
    },
    publicFileUrl: (k: string) => `${FILES}${k}`,
    falApiKey: video ? 'fal-key' : undefined,
    makeVideo: video ? () => video : undefined,
    media: {
      lastFrame: async () => new Uint8Array([0xff, 0xd8, 0xff, 1]),
      concat: async (clips) => new Uint8Array(clips.flatMap((c) => [...c])),
    },
  });
  return { app, objects };
}

function form(fields: Record<string, string>, file: { name: string; type: string; body: Buffer }) {
  const b = `----agently${randomBytes(6).toString('hex')}`;
  const parts = Object.entries(fields).map(([k, v]) => Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  const payload = Buffer.concat([
    ...parts,
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`),
    file.body,
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
}

async function admin(role: 'super_admin' | 'support') {
  const [user] = await db
    .insert(platformUsers)
    .values({ name: role, email: `${randomBytes(5).toString('hex')}@agently.test`, role, passwordHash: 'x', totpConfirmedAt: new Date() })
    .returning();
  const token = randomBytes(16).toString('hex');
  await db.insert(platformSessions).values({ platformUserId: user!.id, tokenHash: createHash('sha256').update(token).digest('hex'), verified: true, expiresAt: new Date(Date.now() + 3600_000) });
  return { cookies: { agently_admin: token }, headers: { origin: ADMIN } };
}

async function shop(credits: number, role: 'owner' | 'agent' = 'owner') {
  const [ws] = await db.insert(workspaces).values({ name: 'Shop', status: 'active' }).returning();
  const [user] = await db.insert(users).values({ name: 'Owner' }).returning();
  await db.insert(memberships).values({ workspaceId: ws!.id, userId: user!.id, role });
  if (credits) await db.insert(creditGrants).values({ workspaceId: ws!.id, reason: 'plan', credits, expiresAt: new Date(Date.now() + 30 * 864e5) });
  const token = randomBytes(16).toString('hex');
  await db.insert(sessions).values({ userId: user!.id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 864e5) });
  return { ws: ws!, auth: { cookies: { agently_session: token }, headers: { origin: WEB } } };
}

async function addModel(app: ReturnType<typeof server>['app'], name = 'Nadia') {
  const auth = await admin('super_admin');
  const f = form({ name, gender: 'female' }, { name: 'nadia.jpg', type: 'image/jpeg', body: JPEG });
  const res = await app.inject({ method: 'POST', url: '/admin/models', ...auth, headers: { ...auth.headers, ...f.headers }, payload: f.payload });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().model as { id: string; imageUrl: string; imageKey: string };
}

async function waitFor(app: ReturnType<typeof server>['app'], path: string, auth: object) {
  for (let i = 0; i < 250; i++) {
    const r = await app.inject({ method: 'GET', url: path, ...auth });
    const v = r.json().video;
    if (v.status !== 'pending') return v;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error('still pending');
}


async function uploadPhoto(app: ReturnType<typeof server>['app'], wsId: string, auth: { headers: Record<string, string> }) {
  const f = form({}, { name: 'look.jpg', type: 'image/jpeg', body: JPEG });
  const up = await app.inject({ method: 'POST', url: `/api/workspaces/${wsId}/uploads/images`, ...auth, headers: { ...auth.headers, ...f.headers }, payload: f.payload });
  assert.equal(up.statusCode, 201, up.body);
  return up.json().url as string;
}

test('videos are off without a fal.ai key', { skip }, async () => {
  const { app } = server();
  const { ws, auth } = await shop(100);
  const setup = await app.inject({ method: 'GET', url: `/api/workspaces/${ws.id}/videos/setup`, ...auth });
  assert.equal(setup.json().enabled, false);
  const res = await app.inject({ method: 'POST', url: `/api/workspaces/${ws.id}/videos`, ...auth, payload: { sourceImageUrl: `${FILES}x.jpg`, script: 'hi' } });
  assert.equal(res.statusCode, 503);
});

test('a talking video from a script: voice, lip-sync, saved, and paid by the second', { skip }, async () => {
  const { video, calls } = fakeVideo();
  const { app, objects } = server(video);
  const { ws, auth } = await shop(1000);
  const setup = await app.inject({ method: 'GET', url: `/api/workspaces/${ws.id}/videos/setup`, ...auth });
  assert.equal(setup.json().enabled, true);
  assert.equal(setup.json().creditsPerSecond, 15);
  const photo = await uploadPhoto(app, ws.id, auth);

  const started = await app.inject({
    method: 'POST',
    url: `/api/workspaces/${ws.id}/videos`,
    ...auth,
    payload: { sourceImageUrl: photo, script: 'Our new Eid collection is here!', voice: 'Calm_Woman', language: 'English', gesture: 'presenting', camera: 'zoom-in' },
  });
  assert.equal(started.statusCode, 202, started.body);
  const done = await waitFor(app, `/api/workspaces/${ws.id}/videos/${started.json().video.id}`, auth);
  assert.equal(done.status, 'succeeded', done.error);
  assert.deepEqual(calls.speak[0], { text: 'Our new Eid collection is here!', voice: 'Calm_Woman', language: 'English', emotion: 'happy' });
  const talk = calls.talk[0] as { imageUrl: string; audioUrl: string; prompt: string };
  assert.equal(talk.imageUrl, photo);
  assert.equal(talk.audioUrl, 'https://fal.media/voice.mp3');
  assert.match(talk.prompt, /zooms in/);
  assert.equal(done.credits, 7 * 15);
  assert.ok(objects.has((done.resultVideoUrl as string).slice(FILES.length)));
  const [usage] = await db.select().from(usageRecords).where(eq(usageRecords.workspaceId, ws.id));
  assert.equal(usage!.model, 'video:fal-ai/kling-video/ai-avatar/v2/standard');
  assert.equal(usage!.aiReplies, 105);
});

test('walk and talk puts the script in the prompt; a recording skips the voice step', { skip }, async () => {
  const { video, calls } = fakeVideo();
  const { app } = server(video);
  const { ws, auth } = await shop(1000);
  const photo = await uploadPhoto(app, ws.id, auth);

  const walk = await app.inject({
    method: 'POST',
    url: `/api/workspaces/${ws.id}/videos`,
    ...auth,
    payload: { sourceImageUrl: photo, mode: 'walk', script: 'Shop the look today', gesture: 'walk', camera: 'follow', seconds: 5 },
  });
  assert.equal(walk.statusCode, 202, walk.body);
  const w = await waitFor(app, `/api/workspaces/${ws.id}/videos/${walk.json().video.id}`, auth);
  assert.equal(w.status, 'succeeded');
  const req = calls.walk[0] as { prompt: string; seconds: number };
  assert.equal(req.seconds, 5);
  assert.match(req.prompt, /says: "shop the look today"/);
  assert.match(req.prompt, /tracks the model/);
  assert.equal(w.credits, 75);

  const f = form({}, { name: 'voice.mp3', type: 'audio/mpeg', body: Buffer.from([0x49, 0x44, 0x33, 1]) });
  const up = await app.inject({ method: 'POST', url: `/api/workspaces/${ws.id}/uploads/audio`, ...auth, headers: { ...auth.headers, ...f.headers }, payload: f.payload });
  assert.equal(up.statusCode, 201, up.body);
  const rec = await app.inject({ method: 'POST', url: `/api/workspaces/${ws.id}/videos`, ...auth, payload: { sourceImageUrl: photo, audioUrl: up.json().url } });
  assert.equal(rec.statusCode, 202, rec.body);
  await waitFor(app, `/api/workspaces/${ws.id}/videos/${rec.json().video.id}`, auth);
  assert.equal(calls.speak.length, 0);
  assert.equal((calls.talk[0] as { audioUrl: string }).audioUrl, up.json().url);
});

test('a silent walk video turns off sound and speech; talking needs a voice', { skip }, async () => {
  const { video, calls } = fakeVideo();
  const { app } = server(video);
  const { ws, auth } = await shop(1000);
  const photo = await uploadPhoto(app, ws.id, auth);

  const walk = await app.inject({
    method: 'POST',
    url: `/api/workspaces/${ws.id}/videos`,
    ...auth,
    payload: { sourceImageUrl: photo, mode: 'walk', speak: false, script: 'ignored', seconds: 5 },
  });
  assert.equal(walk.statusCode, 202, walk.body);
  const w = await waitFor(app, `/api/workspaces/${ws.id}/videos/${walk.json().video.id}`, auth);
  assert.equal(w.status, 'succeeded');
  const req = calls.walk[0] as { prompt: string; silent?: boolean };
  assert.equal(req.silent, true);
  assert.match(req.prompt, /does not talk/);
  assert.doesNotMatch(req.prompt, /ignored/);
  assert.equal(calls.speak.length, 0);

  const talk = await app.inject({ method: 'POST', url: `/api/workspaces/${ws.id}/videos`, ...auth, payload: { sourceImageUrl: photo, mode: 'talk', speak: false } });
  assert.equal(talk.statusCode, 400, talk.body);
});

test('videos refuse other photos, missing scripts, no credits, staff, and record failures', { skip }, async () => {
  const { video } = fakeVideo(true);
  const { app } = server(video);
  const { ws, auth } = await shop(1000);
  const photo = await uploadPhoto(app, ws.id, auth);
  const post = (payload: object, a = auth, id = ws.id) => app.inject({ method: 'POST', url: `/api/workspaces/${id}/videos`, ...a, payload });

  assert.equal((await post({ sourceImageUrl: 'https://elsewhere.test/a.jpg', script: 'hi' })).statusCode, 400);
  assert.equal((await post({ sourceImageUrl: photo })).statusCode, 400);
  assert.equal((await post({ sourceImageUrl: photo, script: 'hi', camera: 'drone' })).statusCode, 400);
  assert.equal((await post({ sourceImageUrl: photo, mode: 'walk', script: 'hi', seconds: 7 })).statusCode, 400);
  assert.equal((await post({ sourceImageUrl: photo, audioUrl: 'https://elsewhere.test/a.mp3' })).statusCode, 400);
  assert.equal((await post({ sourceImageUrl: photo, mode: 'walk', script: 'আমাদের নতুন কালেকশন' })).statusCode, 400);

  const poor = await shop(10);
  const poorPhoto = await uploadPhoto(app, poor.ws.id, poor.auth);
  const broke = await post({ sourceImageUrl: poorPhoto, mode: 'walk', script: 'hi' }, poor.auth, poor.ws.id);
  assert.equal(broke.statusCode, 402);

  const staff = await shop(1000, 'agent');
  assert.equal((await post({ sourceImageUrl: photo, script: 'hi' }, staff.auth, staff.ws.id)).statusCode, 403);

  const failed = await post({ sourceImageUrl: photo, script: 'hello there' });
  assert.equal(failed.statusCode, 202);
  const f = await waitFor(app, `/api/workspaces/${ws.id}/videos/${failed.json().video.id}`, auth);
  assert.equal(f.status, 'failed');
  assert.equal(f.error, 'The AI could not make this video: boom');
  assert.equal(f.credits, 0);
});

test('a 30-second walk and talk is made as 3 clips, each from the last frame, then joined', { skip }, async () => {
  const { video, calls } = fakeVideo();
  const { app, objects } = server(video);
  const { ws, auth } = await shop(2000);
  const photo = await uploadPhoto(app, ws.id, auth);
  const started = await app.inject({
    method: 'POST',
    url: `/api/workspaces/${ws.id}/videos`,
    ...auth,
    payload: { sourceImageUrl: photo, mode: 'walk', script: 'Welcome to our shop. This dress is pure cotton. Order today!', seconds: 30 },
  });
  assert.equal(started.statusCode, 202, started.body);
  const done = await waitFor(app, `/api/workspaces/${ws.id}/videos/${started.json().video.id}`, auth);
  assert.equal(done.status, 'succeeded', done.error);
  const walks = calls.walk as { imageUrl: string; prompt: string; seconds: number }[];
  assert.equal(walks.length, 3);
  assert.equal(walks[0]!.imageUrl, photo);
  assert.notEqual(walks[1]!.imageUrl, photo);
  assert.match(walks[1]!.prompt, /Continue smoothly/);
  assert.match(walks[0]!.prompt, /welcome to our shop/);
  assert.equal(done.credits, 15 * 15);
  assert.deepEqual([...objects.get((done.resultVideoUrl as string).slice(FILES.length))!.body], [4, 5, 4, 5, 4, 5]);
  assert.equal((await app.inject({ method: 'POST', url: `/api/workspaces/${ws.id}/videos`, ...auth, payload: { sourceImageUrl: photo, mode: 'walk', script: 'hi', seconds: 25 } })).statusCode, 400);
});
