/** Catalog, knowledge base, shop settings and agent routes against a real database. Needs DATABASE_URL. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { agents, channels, createDb, knowledgeSources, memberships, sessions, users, workspaces, type Db } from '@agently/db';
import type { KnowledgeJob } from '@agently/shared';
import { buildServer } from '../server.ts';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL not set';
const WEB = 'https://app.agently.test';
let db: Db;
let close: () => Promise<void>;

before(() => {
  if (!skip) ({ db, close } = createDb(url!, { max: 4 }));
});
after(async () => {
  if (!skip) await close();
});

function server(opts: { storage?: boolean } = {}) {
  const queued: KnowledgeJob[] = [];
  const objects = new Map<string, { body: Uint8Array; type: string }>();
  const app = buildServer({
    db,
    redis: { ping: async () => 'PONG' },
    inbound: { add: async () => {} },
    meta: { appSecret: 's', verifyToken: 'v' },
    facebook: {} as never,
    graph: {} as never,
    encryptionKey: randomBytes(32).toString('base64'),
    urls: { web: WEB, api: 'https://api.agently.test' },
    cookies: { secure: true },
    enqueueKnowledge: async (job) => void queued.push(job),
    ...(opts.storage
      ? {
          storage: {
            get: async (k) => objects.get(k)!.body,
            put: async (k, body, type) => void objects.set(k, { body, type }),
            delete: async (k) => void objects.delete(k),
          },
          publicFileUrl: (k: string) => `https://files.agently.test/${k}`,
        }
      : {}),
  });
  return { app, queued, objects };
}

async function shop(role: 'owner' | 'agent' = 'owner') {
  const [ws] = await db.insert(workspaces).values({ name: 'Shop', status: 'active' }).returning();
  await db.insert(agents).values({ workspaceId: ws!.id, name: 'Shop assistant' });
  const [user] = await db.insert(users).values({ name: 'Owner' }).returning();
  await db.insert(memberships).values({ workspaceId: ws!.id, userId: user!.id, role });
  const token = randomBytes(16).toString('hex');
  await db.insert(sessions).values({ userId: user!.id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 864e5) });
  return { ws: ws!, auth: { cookies: { agently_session: token }, headers: { origin: WEB } } };
}

/** A multipart/form-data body with one file. */
function multipart(filename: string, type: string, body: Buffer) {
  const boundary = `----agently${randomBytes(6).toString('hex')}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`),
    body,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

const tshirt = {
  title: 'Cotton T-shirt',
  code: 'TS-01',
  price: '850',
  variants: [
    { color: 'Black', size: 'M', stock: 5 },
    { color: 'Black', size: 'L', stock: 3 },
    { color: 'White', size: 'M', stock: 0, price: '900' },
  ],
};

test('catalog: create with a colour × size grid, list, edit the grid, archive', { skip }, async () => {
  const { app } = server();
  const s = await shop();
  const base = `/api/workspaces/${s.ws.id}/products`;

  const created = await app.inject({ method: 'POST', url: base, payload: tshirt, ...s.auth });
  assert.equal(created.statusCode, 201);
  const p = created.json().product;
  assert.deepEqual(p.colors, ['Black', 'White']);
  assert.deepEqual(p.sizes, ['L', 'M']);
  assert.equal(p.totalStock, 8);
  assert.equal(p.variants.find((v: { color: string }) => v.color === 'White').price, '900.00');

  assert.equal((await app.inject({ method: 'POST', url: base, payload: tshirt, ...s.auth })).statusCode, 409);
  const dupCell = await app.inject({ method: 'POST', url: base, payload: { ...tshirt, code: 'TS-02', variants: [{ color: 'Red', size: 'M', stock: 1 }, { color: 'red', size: 'm', stock: 1 }] }, ...s.auth });
  assert.equal(dupCell.statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: base, payload: { ...tshirt, code: 'X', price: 'cheap' }, ...s.auth })).statusCode, 400);

  const blackM = p.variants.find((v: { color: string; size: string }) => v.color === 'Black' && v.size === 'M');
  const edited = await app.inject({
    method: 'PUT',
    url: `${base}/${p.id}`,
    payload: { ...tshirt, price: '799', variants: [{ color: 'black', size: 'm', stock: 9 }, { color: 'Blue', size: 'M', stock: 2 }] },
    ...s.auth,
  });
  assert.equal(edited.statusCode, 200);
  const e = edited.json().product;
  assert.equal(e.price, '799.00');
  assert.equal(e.totalStock, 11);
  // The matching cell keeps its id, so past orders still point at it.
  assert.equal(e.variants.find((v: { color: string }) => v.color === 'black').id, blackM.id);
  assert.equal(e.variants.length, 2);

  const search = await app.inject({ url: `${base}?q=ts-0`, ...s.auth });
  assert.equal(search.json().products.length, 1);

  assert.equal((await app.inject({ method: 'DELETE', url: `${base}/${p.id}`, ...s.auth })).statusCode, 204);
  assert.equal((await app.inject({ url: base, ...s.auth })).json().products.length, 0);
  assert.equal((await app.inject({ url: `${base}?status=archived`, ...s.auth })).json().products.length, 1);
});

test('catalog: staff can read but not edit; other shops get 404', { skip }, async () => {
  const { app } = server();
  const owner = await shop();
  const staff = await shop('agent');
  const created = await app.inject({ method: 'POST', url: `/api/workspaces/${owner.ws.id}/products`, payload: tshirt, ...owner.auth });
  const id = created.json().product.id;

  assert.equal((await app.inject({ method: 'POST', url: `/api/workspaces/${staff.ws.id}/products`, payload: tshirt, ...staff.auth })).statusCode, 403);
  assert.equal((await app.inject({ url: `/api/workspaces/${staff.ws.id}/products`, ...staff.auth })).statusCode, 200);
  assert.equal((await app.inject({ url: `/api/workspaces/${owner.ws.id}/products/${id}`, ...staff.auth })).statusCode, 404);
  // The product id alone doesn't reach across shops either.
  const other = await shop();
  assert.equal((await app.inject({ url: `/api/workspaces/${other.ws.id}/products/${id}`, ...other.auth })).statusCode, 404);
});

test('uploads: product photos are checked and stored under the shop; 503 without storage', { skip }, async () => {
  const s = await shop();
  const uploadUrl = `/api/workspaces/${s.ws.id}/uploads/images`;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(64)]);

  const none = server();
  const m = multipart('a.png', 'image/png', png);
  assert.equal((await none.app.inject({ method: 'POST', url: uploadUrl, payload: m.payload, cookies: s.auth.cookies, headers: { ...m.headers, origin: WEB } })).statusCode, 503);

  const { app, objects } = server({ storage: true });
  const up = (name: string, type: string, body: Buffer) => {
    const m = multipart(name, type, body);
    return app.inject({ method: 'POST', url: uploadUrl, payload: m.payload, cookies: s.auth.cookies, headers: { ...m.headers, origin: WEB } });
  };
  const ok = await up('photo.png', 'image/png', png);
  assert.equal(ok.statusCode, 201);
  assert.match(ok.json().url, new RegExp(`^https://files.agently.test/${s.ws.id}/images/.+\\.png$`));
  assert.equal(objects.size, 1);

  assert.equal((await up('fake.png', 'image/png', Buffer.from('not an image'))).statusCode, 415);
  assert.equal((await up('doc.pdf', 'application/pdf', Buffer.from('%PDF'))).statusCode, 415);
  assert.equal((await up('big.png', 'image/png', Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]))).statusCode, 413);
  assert.equal(objects.size, 1);
});

test('knowledge: add text, Q&A, website, sheet and file sources; edit, re-sync, delete', { skip }, async () => {
  const { app, queued, objects } = server({ storage: true });
  const s = await shop();
  const base = `/api/workspaces/${s.ws.id}/knowledge`;
  const add = (payload: object) => app.inject({ method: 'POST', url: base, payload, ...s.auth });

  const text = await add({ type: 'text', name: 'Return policy', content: '৭ দিনের মধ্যে ফেরত দেওয়া যাবে।' });
  assert.equal(text.statusCode, 201);
  assert.equal(text.json().source.status, 'queued');
  const qa = await add({ type: 'qa', name: 'FAQ', pairs: [{ question: 'Delivery time?', answer: '2-3 days inside Dhaka' }] });
  assert.equal(qa.statusCode, 201);
  assert.equal((await add({ type: 'website', url: 'https://shop.example.com' })).json().source.name, 'https://shop.example.com');
  assert.equal((await add({ type: 'sheet', url: 'https://example.com/sheet' })).statusCode, 400);
  assert.equal((await add({ type: 'sheet', url: 'https://docs.google.com/spreadsheets/d/abc123/edit#gid=0' })).statusCode, 201);
  assert.equal((await add({ type: 'website', url: 'ftp://shop.example.com' })).statusCode, 400);

  const m = multipart('Price list.csv', 'text/csv', Buffer.from('product,price\nT-shirt,850\n'));
  const file = await app.inject({ method: 'POST', url: `${base}/files`, payload: m.payload, cookies: s.auth.cookies, headers: { ...m.headers, origin: WEB } });
  assert.equal(file.statusCode, 201);
  assert.equal(file.json().source.name, 'Price list.csv');
  const exe = multipart('virus.exe', 'application/octet-stream', Buffer.from('MZ'));
  assert.equal((await app.inject({ method: 'POST', url: `${base}/files`, payload: exe.payload, cookies: s.auth.cookies, headers: { ...exe.headers, origin: WEB } })).statusCode, 415);

  assert.equal(queued.length, 5);
  assert.ok(queued.every((j) => j.workspaceId === s.ws.id));

  const list = await app.inject({ url: base, ...s.auth });
  assert.equal(list.json().sources.length, 5);
  assert.equal(list.json().usage.limitBytes, 20 * 1024 * 1024);
  assert.ok(list.json().usage.usedBytes > 0);

  const qaId = qa.json().source.id;
  const detail = await app.inject({ url: `${base}/${qaId}`, ...s.auth });
  assert.deepEqual(detail.json().source.pairs, [{ question: 'Delivery time?', answer: '2-3 days inside Dhaka' }]);
  const edited = await app.inject({ method: 'PATCH', url: `${base}/${qaId}`, payload: { pairs: [{ question: 'COD?', answer: 'Yes' }] }, ...s.auth });
  assert.equal(edited.statusCode, 200);
  assert.equal((await app.inject({ method: 'PATCH', url: `${base}/${qaId}`, payload: { content: 'x' }, ...s.auth })).statusCode, 400);
  assert.equal(queued.length, 6);

  await db.update(knowledgeSources).set({ status: 'failed', error: 'oops' }).where(eq(knowledgeSources.id, qaId));
  const resync = await app.inject({ method: 'POST', url: `${base}/${qaId}/resync`, ...s.auth });
  assert.equal(resync.statusCode, 202);
  assert.equal(resync.json().source.status, 'queued');
  assert.equal(resync.json().source.error, null);

  const fileId = file.json().source.id;
  assert.equal(objects.size, 1);
  assert.equal((await app.inject({ method: 'DELETE', url: `${base}/${fileId}`, ...s.auth })).statusCode, 204);
  assert.equal(objects.size, 0);
  assert.equal((await app.inject({ url: `${base}/${fileId}`, ...s.auth })).statusCode, 404);
});

test("knowledge: the plan's size limit is enforced", { skip }, async () => {
  const { app } = server();
  const s = await shop();
  // 20 MB with no plan; fill it with one big text source (bypassing the 200k body limit).
  await db.insert(knowledgeSources).values({ workspaceId: s.ws.id, type: 'text', name: 'Huge', content: 'x'.repeat(20 * 1024 * 1024 - 10), status: 'ready' });
  const res = await app.inject({ method: 'POST', url: `/api/workspaces/${s.ws.id}/knowledge`, payload: { type: 'text', name: 'More', content: 'one more paragraph' }, ...s.auth });
  assert.equal(res.statusCode, 413);
  assert.match(res.json().error, /20 MB/);
});

test('settings: delivery charges and wallets; at least one way to pay', { skip }, async () => {
  const { app } = server();
  const s = await shop();
  const url = `/api/workspaces/${s.ws.id}/settings`;

  const got = await app.inject({ url, ...s.auth });
  assert.equal(got.json().settings.codEnabled, true);

  const saved = await app.inject({
    method: 'PATCH',
    url,
    payload: { deliveryChargeInsideDhaka: 70, deliveryChargeOutsideDhaka: '130', bkashNumber: '+880 1712-345678', nagadNumber: '০১৮১২৩৪৫৬৭৮' },
    ...s.auth,
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().settings.deliveryChargeInsideDhaka, '70.00');
  assert.equal(saved.json().settings.bkashNumber, '01712345678');
  assert.equal(saved.json().settings.nagadNumber, '01812345678');

  assert.equal((await app.inject({ method: 'PATCH', url, payload: { bkashNumber: '12345' }, ...s.auth })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url, payload: { unknown: 1 }, ...s.auth })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url, payload: { codEnabled: false }, ...s.auth })).statusCode, 200);
  const noWay = await app.inject({ method: 'PATCH', url, payload: { bkashNumber: null, nagadNumber: '' }, ...s.auth });
  assert.equal(noWay.statusCode, 400);
  assert.match(noWay.json().error, /payment method/);

  assert.equal((await app.inject({ method: 'POST', url: `/api/workspaces/${s.ws.id}/onboarding/complete`, ...s.auth })).statusCode, 204);
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, s.ws.id));
  assert.ok(ws!.onboardingCompletedAt);

  const staff = await shop('agent');
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/workspaces/${staff.ws.id}/settings`, payload: { codEnabled: true }, ...staff.auth })).statusCode, 403);
});

test('agent: settings save; going live needs a connected page', { skip }, async () => {
  const { app } = server();
  const s = await shop();
  const url = `/api/workspaces/${s.ws.id}/agent`;

  const saved = await app.inject({
    method: 'PATCH',
    url,
    payload: { name: 'Mina', tone: 'professional', systemInstruction: 'Always greet with Assalamu alaikum.', commentReplyMode: 'private', handoffRules: { minConfidence: 0.6, onComplaint: true, onHumanRequest: true, keywords: ['refund'] } },
    ...s.auth,
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().agent.name, 'Mina');
  assert.deepEqual(saved.json().agent.handoffRules.keywords, ['refund']);
  assert.equal((await app.inject({ method: 'PATCH', url, payload: { tone: 'rude' }, ...s.auth })).statusCode, 400);

  const early = await app.inject({ method: 'PATCH', url, payload: { status: 'live' }, ...s.auth });
  assert.equal(early.statusCode, 409);
  await db.insert(channels).values({ workspaceId: s.ws.id, type: 'facebook_page', externalId: `page-${randomBytes(4).toString('hex')}`, name: 'Page' });
  const live = await app.inject({ method: 'PATCH', url, payload: { status: 'live' }, ...s.auth });
  assert.equal(live.statusCode, 200);
  assert.equal(live.json().agent.status, 'live');
  assert.equal((await app.inject({ url, ...s.auth })).json().agent.systemInstruction, 'Always greet with Assalamu alaikum.');
});
