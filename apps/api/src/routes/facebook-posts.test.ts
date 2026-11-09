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

type Published = { token: string; pageId: string; message: string; button?: { type: string; link: string; target?: string }; photoUrls?: string[] };

function server(fail?: GraphApiError) {
  const published: Published[] = [];
  let posts = 0;
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
        published.push({ token, pageId, message: post.message, ...(post.button ? { button: post.button } : { photoUrls: post.photoUrls }) });
        return `${pageId}_${++posts}`;
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

test('posts a product with its text and an Order Now button, and links the post to the product', { skip }, async () => {
  const { app, published } = server();
  const { ws, page, product, auth } = await shop();
  const path = `/api/workspaces/${ws.id}/products/${product.id}/facebook-posts`;

  const res = await app.inject({
    method: 'POST',
    url: path,
    payload: { message: 'Eid collection is here!\n\nCotton Panjabi ৳1,450', button: { type: 'order', orderTo: 'messenger' } },
    ...auth,
  });
  assert.equal(res.statusCode, 201, res.body);
  const { post } = res.json();
  assert.equal(post.postId, `${page.externalId}_1`);
  assert.equal(post.url, `https://www.facebook.com/${page.externalId}_1`);
  assert.deepEqual(published, [
    {
      token: 'page-token',
      pageId: page.externalId,
      message: 'Eid collection is here!\n\nCotton Panjabi ৳1,450',
      button: { type: 'ORDER_NOW', link: `https://api.agently.test/share/products/${product.id}`, target: `https://m.me/${page.externalId}?ref=order_${product.id}` },
    },
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

  const foreign = await app.inject({ method: 'POST', url: path, payload: { message: 'Hi', photoUrls: ['https://evil.test/x.jpg'], button: { type: 'message' } }, ...owner.auth });
  assert.equal(foreign.statusCode, 400);
  const empty = await app.inject({ method: 'POST', url: path, payload: { message: '   ', button: { type: 'message' } }, ...owner.auth });
  assert.equal(empty.statusCode, 400);

  const staff = await shop('agent');
  const denied = await app.inject({
    method: 'POST',
    url: `/api/workspaces/${staff.ws.id}/products/${staff.product.id}/facebook-posts`,
    payload: { message: 'Hi', button: { type: 'message' } },
    ...staff.auth,
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(published.length, 0);
});

test('explains a missing posting permission, and flags a revoked page token', { skip }, async () => {
  const noPerm = server(new GraphApiError('(#200) The user hasn\'t authorized the application to perform this action', 403, 200));
  const a = await shop();
  const res = await noPerm.app.inject({ method: 'POST', url: `/api/workspaces/${a.ws.id}/products/${a.product.id}/facebook-posts`, payload: { message: 'Hi', button: { type: 'message' } }, ...a.auth });
  assert.equal(res.statusCode, 403);
  assert.match(res.json().error, /permission to post/);
  assert.equal((await db.select().from(productPosts).where(eq(productPosts.productId, a.product.id))).length, 0);

  const revoked = server(new GraphApiError('Session expired', 400, 190));
  const b = await shop();
  const r2 = await revoked.app.inject({ method: 'POST', url: `/api/workspaces/${b.ws.id}/products/${b.product.id}/facebook-posts`, payload: { message: 'Hi', button: { type: 'message' } }, ...b.auth });
  assert.equal(r2.statusCode, 409);
  const [page] = await db.select().from(channels).where(eq(channels.id, b.page.id));
  assert.equal(page!.status, 'token_expired');
});

test('Order Now to the website or Messenger, Send Message, and the share page with the catalog photo', { skip }, async () => {
  const { app, published } = server();
  const { ws, page, product, auth } = await shop();
  const path = `/api/workspaces/${ws.id}/products/${product.id}/facebook-posts`;

  // No button: the chosen photos go up together as one post.
  const plain = await app.inject({ method: 'POST', url: path, payload: { message: 'New in', photoUrls: ['https://files.test/b.jpg', 'https://files.test/a.jpg'] }, ...auth });
  assert.equal(plain.statusCode, 201, plain.body);
  assert.deepEqual({ ...published[0] }, { token: 'page-token', pageId: page.externalId, message: 'New in', photoUrls: ['https://files.test/b.jpg', 'https://files.test/a.jpg'] });
  const noSite = await app.inject({ method: 'POST', url: path, payload: { message: 'New in', button: { type: 'order' } }, ...auth });
  assert.equal(noSite.statusCode, 400);
  published.splice(0);

  const share = (photo = 0) => `https://api.agently.test/share/products/${product.id}${photo ? `?photo=${photo}` : ''}`;
  const real = await app.inject({
    method: 'POST',
    url: path,
    payload: { message: 'New in', photoUrls: ['https://files.test/b.jpg'], button: { type: 'order', websiteUrl: 'https://banggii.com/p/pj-01' } },
    ...auth,
  });
  assert.equal(real.statusCode, 201, real.body);
  assert.equal(published[0]!.message, 'New in');
  // The post links to the share page with the chosen catalog photo; the button opens the website.
  assert.deepEqual(published[0]!.button, { type: 'ORDER_NOW', link: share(1), target: 'https://banggii.com/p/pj-01' });
  const [saved] = await db.select().from(products).where(eq(products.id, product.id));
  assert.equal(saved!.websiteUrl, 'https://banggii.com/p/pj-01');

  // The website is remembered for the next post.
  const again = await app.inject({ method: 'POST', url: path, payload: { message: 'New in', button: { type: 'order' } }, ...auth });
  assert.equal(again.statusCode, 201, again.body);
  assert.deepEqual(published[1]!.button, { type: 'ORDER_NOW', link: share(), target: 'https://banggii.com/p/pj-01' });

  const toChat = await app.inject({ method: 'POST', url: path, payload: { message: 'New in', button: { type: 'order', orderTo: 'messenger' } }, ...auth });
  assert.equal(toChat.statusCode, 201);
  assert.deepEqual(published[2]!.button, { type: 'ORDER_NOW', link: share(), target: `https://m.me/${page.externalId}?ref=order_${product.id}` });

  const send = await app.inject({ method: 'POST', url: path, payload: { message: 'New in', button: { type: 'message' } }, ...auth });
  assert.equal(send.statusCode, 201);
  assert.deepEqual(published[3]!.button, { type: 'MESSAGE_PAGE', link: share() });

  const noPage = await app.inject({ method: 'POST', url: path, payload: { message: 'New in', button: { type: 'order', websiteUrl: 'nope' } }, ...auth });
  assert.equal(noPage.statusCode, 400);

  // The share page: Facebook sees the catalog photo, name and price; people go to the website.
  const crawler = await app.inject({ url: '/share/products/' + product.id + '?photo=1', headers: { 'user-agent': 'facebookexternalhit/1.1' } });
  assert.equal(crawler.statusCode, 200);
  assert.match(crawler.body, /<meta property="og:image" content="https:\/\/files.test\/b.jpg">/);
  assert.match(crawler.body, /og:title" content="Cotton Panjabi · ৳1,450"/);
  const person = await app.inject({ url: '/share/products/' + product.id, headers: { 'user-agent': 'Mozilla/5.0' } });
  assert.equal(person.statusCode, 302);
  assert.equal(person.headers.location, 'https://banggii.com/p/pj-01');

  const bad = await app.inject({ method: 'POST', url: path, payload: { message: 'New in', button: { type: 'call' } }, ...auth });
  assert.equal(bad.statusCode, 400);
});
