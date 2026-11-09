/** Posting a product on the shop's Facebook page, against a real database. Needs DATABASE_URL. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { activities, agents, channels, createDb, memberships, productPosts, products, productVariants, sessions, users, workspaces, type Db } from '@agently/db';
import { GraphApiError } from '@agently/meta';
import { encryptSecret } from '@agently/shared';
import { buildServer } from '../server.ts';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL not set';
const key = randomBytes(32).toString('base64');
const WEB = 'https://app.agently.test';
let db: Db;
let close: () => Promise<void>;

before(() => {
  if (!skip) ({ db, close } = createDb(url!, { max: 4 }));
});
after(async () => {
  if (!skip) await close();
});

type Published = { token: string; pageId: string; message: string; photoUrls: string[] };

function server(fail?: GraphApiError) {
  const published: Published[] = [];
  const app = buildServer({
    db,
    redis: { ping: async () => 'PONG' },
    inbound: { add: async () => {} },
    meta: { appSecret: 's', verifyToken: 'v' },
    facebook: {} as never,
    graph: {
      sendText: async () => ['mid'],
      replyToComment: async () => 'cid',
      publishPost: async (token, pageId, post) => {
        if (fail) throw fail;
        published.push({ token, pageId, ...post });
        return `${pageId}_${published.length}`;
      },
    },
    encryptionKey: key,
    urls: { web: WEB, api: 'https://api.agently.test' },
    cookies: { secure: true },
    enqueueKnowledge: async () => {},
  });
  return { app, published };
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
  const [product] = await db
    .insert(products)
    .values({
      workspaceId: ws!.id,
      title: 'Cotton Panjabi',
      code: 'PJ-01',
      price: '1450',
      imageUrl: 'https://files.test/a.jpg',
      images: [
        { url: 'https://files.test/a.jpg', color: '' },
        { url: 'https://files.test/b.jpg', color: 'Blue' },
      ],
    })
    .returning();
  await db.insert(productVariants).values({ workspaceId: ws!.id, productId: product!.id, color: 'Blue', size: 'L', stock: 4 });
  return { ws: ws!, page: page!, product: product!, auth: { cookies: { agently_session: token }, headers: { origin: WEB } } };
}

test('posts a product with chosen photos and custom text, and links the post to the product', { skip }, async () => {
  const { app, published } = server();
  const { ws, page, product, auth } = await shop();
  const path = `/api/workspaces/${ws.id}/products/${product.id}/facebook-posts`;

  const res = await app.inject({
    method: 'POST',
    url: path,
    payload: { message: 'Eid collection is here!\n\nCotton Panjabi ৳1,450', photoUrls: ['https://files.test/b.jpg', 'https://files.test/a.jpg'] },
    ...auth,
  });
  assert.equal(res.statusCode, 201, res.body);
  const { post } = res.json();
  assert.equal(post.postId, `${page.externalId}_1`);
  assert.equal(post.url, `https://www.facebook.com/${page.externalId}_1`);
  assert.deepEqual(published, [
    { token: 'page-token', pageId: page.externalId, message: 'Eid collection is here!\n\nCotton Panjabi ৳1,450', photoUrls: ['https://files.test/b.jpg', 'https://files.test/a.jpg'] },
  ]);

  const [row] = await db.select().from(productPosts).where(eq(productPosts.productId, product.id));
  assert.equal(row!.postId, post.postId);
  assert.equal(row!.channelId, page.id);
  const feed = await db.select().from(activities).where(eq(activities.workspaceId, ws.id));
  assert.ok(feed.some((a) => a.type === 'product.posted'));

  const list = await app.inject({ url: path, ...auth });
  assert.deepEqual(list.json().posts.map((p: { postId: string; pageName: string }) => [p.postId, p.pageName]), [[post.postId, 'Banggii.com']]);
});

test('refuses photos from elsewhere, empty text, and staff without manager rights', { skip }, async () => {
  const { app, published } = server();
  const owner = await shop();
  const path = `/api/workspaces/${owner.ws.id}/products/${owner.product.id}/facebook-posts`;

  const foreign = await app.inject({ method: 'POST', url: path, payload: { message: 'Hi', photoUrls: ['https://evil.test/x.jpg'] }, ...owner.auth });
  assert.equal(foreign.statusCode, 400);
  const empty = await app.inject({ method: 'POST', url: path, payload: { message: '   ' }, ...owner.auth });
  assert.equal(empty.statusCode, 400);

  const staff = await shop('agent');
  const denied = await app.inject({
    method: 'POST',
    url: `/api/workspaces/${staff.ws.id}/products/${staff.product.id}/facebook-posts`,
    payload: { message: 'Hi' },
    ...staff.auth,
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(published.length, 0);
});

test('explains a missing posting permission, and flags a revoked page token', { skip }, async () => {
  const noPerm = server(new GraphApiError('(#200) The user hasn\'t authorized the application to perform this action', 403, 200));
  const a = await shop();
  const res = await noPerm.app.inject({ method: 'POST', url: `/api/workspaces/${a.ws.id}/products/${a.product.id}/facebook-posts`, payload: { message: 'Hi' }, ...a.auth });
  assert.equal(res.statusCode, 403);
  assert.match(res.json().error, /permission to post/);
  assert.equal((await db.select().from(productPosts).where(eq(productPosts.productId, a.product.id))).length, 0);

  const revoked = server(new GraphApiError('Session expired', 400, 190));
  const b = await shop();
  const r2 = await revoked.app.inject({ method: 'POST', url: `/api/workspaces/${b.ws.id}/products/${b.product.id}/facebook-posts`, payload: { message: 'Hi' }, ...b.auth });
  assert.equal(r2.statusCode, 409);
  const [page] = await db.select().from(channels).where(eq(channels.id, b.page.id));
  assert.equal(page!.status, 'token_expired');
});
