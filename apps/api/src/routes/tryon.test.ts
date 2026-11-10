/** Model characters (super admin) and product images with models (shop). Needs DATABASE_URL. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { TryOnError, type TryOnProvider } from '@agently/ai';
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

function server(tryOn?: TryOnProvider) {
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
    tryOn,
  });
  return { app, objects };
}

type Seen = { model?: number[]; garment?: number[]; category?: string; style?: unknown; note?: string };
const fakeTryOn = (fail = false): TryOnProvider & { seen: Seen } => {
  const seen: Seen = {};
  return {
    name: 'fake',
    model: 'fake-tryon-1',
    seen,
    async tryOn(req) {
      seen.model = [...req.model.bytes];
      seen.garment = [...req.garment.bytes];
      seen.category = req.category;
      seen.style = req.style;
      seen.note = req.note;
      if (fail) throw new TryOnError('PoseError', 'No clear person');
      return { image: { bytes: new Uint8Array(PNG), contentType: 'image/png' }, costUsd: 0.05 };
    },
  };
};

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
    const image = r.json().image;
    if (image.status !== 'pending') return image;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error('still pending');
}

test('super admins add model characters; support can only look', { skip }, async () => {
  const { app, objects } = server();
  const model = await addModel(app);
  assert.ok(model.imageUrl.startsWith(`${FILES}platform/models/`));
  assert.ok(objects.has(model.imageKey));

  const support = await admin('support');
  const f = form({ name: 'Rafi', gender: 'male' }, { name: 'r.jpg', type: 'image/jpeg', body: JPEG });
  const refused = await app.inject({ method: 'POST', url: '/admin/models', ...support, headers: { ...support.headers, ...f.headers }, payload: f.payload });
  assert.equal(refused.statusCode, 403);
  const list = await app.inject({ method: 'GET', url: '/admin/models', ...support });
  assert.ok(list.json().models.some((m: { id: string }) => m.id === model.id));

  const sa = await admin('super_admin');
  const bad = form({ name: 'X', gender: 'other' }, { name: 'x.jpg', type: 'image/jpeg', body: JPEG });
  assert.equal((await app.inject({ method: 'POST', url: '/admin/models', ...sa, headers: { ...sa.headers, ...bad.headers }, payload: bad.payload })).statusCode, 400);
  const fake = form({ name: 'X', gender: 'male' }, { name: 'x.jpg', type: 'image/jpeg', body: Buffer.from('not an image') });
  assert.equal((await app.inject({ method: 'POST', url: '/admin/models', ...sa, headers: { ...sa.headers, ...fake.headers }, payload: fake.payload })).statusCode, 415);

  const hidden = await app.inject({ method: 'PATCH', url: `/admin/models/${model.id}`, ...sa, payload: { active: false, name: 'Nadia 2' } });
  assert.equal(hidden.json().model.active, false);
  const del = await app.inject({ method: 'DELETE', url: `/admin/models/${model.id}`, ...sa });
  assert.equal(del.statusCode, 204);
  assert.ok(!objects.has(model.imageKey));
});

test('a shop makes a product image with a model and pays in credits', { skip }, async () => {
  const tryOn = fakeTryOn();
  const { app, objects } = server(tryOn);
  const model = await addModel(app);
  const { ws, auth } = await shop(100);

  const models = await app.inject({ method: 'GET', url: `/api/workspaces/${ws.id}/try-on/models`, ...auth });
  assert.equal(models.json().enabled, true);
  assert.equal(models.json().creditsPerImage, 10);
  assert.ok(models.json().models.some((m: { id: string }) => m.id === model.id));

  const f = form({}, { name: 'dress.jpg', type: 'image/jpeg', body: Buffer.from([0xff, 0xd8, 0xff, 7]) });
  const up = await app.inject({ method: 'POST', url: `/api/workspaces/${ws.id}/uploads/images`, ...auth, headers: { ...auth.headers, ...f.headers }, payload: f.payload });
  const garmentImageUrl = up.json().url as string;

  const started = await app.inject({ method: 'POST', url: `/api/workspaces/${ws.id}/try-on`, ...auth, payload: { characterId: model.id, garmentImageUrl, category: 'one-pieces', pose: 'sitting', background: 'garden', note: 'smiling, holding a clutch' } });
  assert.equal(started.statusCode, 202, started.body);
  assert.equal(started.json().image.status, 'pending');
  const done = await waitFor(app, `/api/workspaces/${ws.id}/try-on/${started.json().image.id}`, auth);
  assert.equal(done.status, 'succeeded');
  assert.deepEqual(tryOn.seen.model, [...JPEG]);
  assert.deepEqual(tryOn.seen.garment, [0xff, 0xd8, 0xff, 7]);
  assert.equal(tryOn.seen.category, 'one-pieces');
  assert.deepEqual(tryOn.seen.style, { pose: 'sitting', expression: undefined, background: 'garden' });
  assert.equal(tryOn.seen.note, 'smiling, holding a clutch');
  assert.equal(models.json().styleOptions, true);
  const badPose = await app.inject({ method: 'POST', url: `/api/workspaces/${ws.id}/try-on`, ...auth, payload: { characterId: model.id, garmentImageUrl, pose: 'flying' } });
  assert.equal(badPose.statusCode, 400);
  const key = (done.resultImageUrl as string).slice(FILES.length);
  assert.ok(key.startsWith(`${ws.id}/images/`) && key.endsWith('.png'));
  assert.deepEqual([...objects.get(key)!.body], [...PNG]);

  const [usage] = await db.select().from(usageRecords).where(eq(usageRecords.workspaceId, ws.id));
  assert.equal(usage!.model, 'tryon:fake-tryon-1');
  assert.equal(usage!.aiReplies, 10);
  assert.equal(Number(usage!.costUsd), 0.05);

  const list = await app.inject({ method: 'GET', url: `/api/workspaces/${ws.id}/try-on`, ...auth });
  assert.equal(list.json().images.length, 1);
  const del = await app.inject({ method: 'DELETE', url: `/api/workspaces/${ws.id}/try-on/${done.id}`, ...auth });
  assert.equal(del.statusCode, 204);
});

test('try-on refuses other photos, no credits, staff, and records failures', { skip }, async () => {
  const { app } = server(fakeTryOn(true));
  const model = await addModel(app);
  const { ws, auth } = await shop(100);
  const other = await shop(100);
  const own = `${FILES}${ws.id}/images/abc.jpg`;

  const foreign = await app.inject({ method: 'POST', url: `/api/workspaces/${ws.id}/try-on`, ...auth, payload: { characterId: model.id, garmentImageUrl: `${FILES}${other.ws.id}/images/abc.jpg` } });
  assert.equal(foreign.statusCode, 400);
  const web = await app.inject({ method: 'POST', url: `/api/workspaces/${ws.id}/try-on`, ...auth, payload: { characterId: model.id, garmentImageUrl: 'https://example.com/a.jpg' } });
  assert.equal(web.statusCode, 400);

  const broke = await shop(5);
  const poor = await app.inject({ method: 'POST', url: `/api/workspaces/${broke.ws.id}/try-on`, ...broke.auth, payload: { characterId: model.id, garmentImageUrl: `${FILES}${broke.ws.id}/images/abc.jpg` } });
  assert.equal(poor.statusCode, 402);

  const staff = await shop(100, 'agent');
  const refused = await app.inject({ method: 'POST', url: `/api/workspaces/${staff.ws.id}/try-on`, ...staff.auth, payload: { characterId: model.id, garmentImageUrl: `${FILES}${staff.ws.id}/images/abc.jpg` } });
  assert.equal(refused.statusCode, 403);

  // The garment file is missing from storage here, so the run fails and nothing is charged.
  const started = await app.inject({ method: 'POST', url: `/api/workspaces/${ws.id}/try-on`, ...auth, payload: { characterId: model.id, garmentImageUrl: own } });
  assert.equal(started.statusCode, 202);
  const failed = await waitFor(app, `/api/workspaces/${ws.id}/try-on/${started.json().image.id}`, auth);
  assert.equal(failed.status, 'failed');
  assert.ok(failed.error);
  const [usage] = await db.select().from(usageRecords).where(eq(usageRecords.workspaceId, ws.id));
  assert.equal(usage!.aiReplies, 0);
  assert.equal(usage!.failedCalls, 1);

  await db.delete(modelCharacters).where(eq(modelCharacters.id, model.id));
});

test('without a try-on service the feature says it is off', { skip }, async () => {
  const { app } = server();
  const { ws, auth } = await shop(100);
  const models = await app.inject({ method: 'GET', url: `/api/workspaces/${ws.id}/try-on/models`, ...auth });
  assert.equal(models.json().enabled, false);
  const res = await app.inject({ method: 'POST', url: `/api/workspaces/${ws.id}/try-on`, ...auth, payload: { characterId: randomUUID(), garmentImageUrl: `${FILES}${ws.id}/images/a.jpg` } });
  assert.equal(res.statusCode, 503);
});

test('a super admin sets the try-on service and key; the key never comes back', { skip }, async () => {
  const { app } = server();
  const sa = await admin('super_admin');
  const { ws, auth } = await shop(100);

  const off = await app.inject({ method: 'GET', url: '/admin/tryon-service', ...sa });
  assert.equal(off.json().service.source, 'off');

  const put = await app.inject({ method: 'PUT', url: '/admin/tryon-service', ...sa, payload: { provider: 'gemini', model: 'gemini-x', apiKey: 'secret-key-000000001234' } });
  assert.equal(put.statusCode, 204, put.body);
  const got = await app.inject({ method: 'GET', url: '/admin/tryon-service', ...sa });
  assert.equal(got.json().service.source, 'settings');
  assert.equal(got.json().service.apiKeyLast4, '1234');
  assert.deepEqual(got.json().service.active, { provider: 'gemini', model: 'gemini-x' });
  assert.ok(!got.body.includes('secret-key'));
  const all = await app.inject({ method: 'GET', url: '/admin/settings', ...sa });
  assert.ok(!('tryon.service' in all.json().settings));

  // The shop now sees the feature switched on, without any .env key.
  const models = await app.inject({ method: 'GET', url: `/api/workspaces/${ws.id}/try-on/models`, ...auth });
  assert.equal(models.json().enabled, true);

  // Changing the model keeps the saved key.
  await app.inject({ method: 'PUT', url: '/admin/tryon-service', ...sa, payload: { provider: 'fashn', mode: 'balanced' } });
  const kept = await app.inject({ method: 'GET', url: '/admin/tryon-service', ...sa });
  assert.equal(kept.json().service.apiKeyLast4, '1234');
  assert.equal(kept.json().service.active.provider, 'fashn');

  // A browser-filled email in the Model box is refused.
  const email = await app.inject({ method: 'PUT', url: '/admin/tryon-service', ...sa, payload: { provider: 'fal', model: 'someone@example.com' } });
  assert.equal(email.statusCode, 400);
  // So is a password filled into the fal key box.
  const password = await app.inject({ method: 'PUT', url: '/admin/tryon-service', ...sa, payload: { provider: 'fal', apiKey: 'MyPassw0rd!' } });
  assert.equal(password.statusCode, 400);
  const falKey = await app.inject({ method: 'PUT', url: '/admin/tryon-service', ...sa, payload: { provider: 'fal', apiKey: 'fal_AbCdEf0123456789xyz' } });
  assert.equal(falKey.statusCode, 204);

  const support = await admin('support');
  assert.equal((await app.inject({ method: 'GET', url: '/admin/tryon-service', ...support })).statusCode, 403);

  await app.inject({ method: 'PUT', url: '/admin/tryon-service', ...sa, payload: { provider: 'fashn', apiKey: '' } });
  const removed = await app.inject({ method: 'GET', url: '/admin/tryon-service', ...sa });
  assert.equal(removed.json().service.source, 'off');
});
