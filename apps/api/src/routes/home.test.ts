/** Dashboard home, channels, activity feed, comments and sign-out. Needs DATABASE_URL. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createOrder } from '@agently/commerce';
import {
  activities,
  agents,
  channels,
  conversations,
  createDb,
  customerIdentities,
  customers,
  memberships,
  messages,
  productVariants,
  products,
  sessions,
  users,
  workspaces,
  type Db,
} from '@agently/db';
import { encryptSecret } from '@agently/shared';
import { buildServer } from '../server.ts';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL not set';
const key = randomBytes(32).toString('base64');
const WEB = 'https://app.agently.test';
let db: Db;
let close: () => Promise<void>;
let sent: { to: string; text: string }[] = [];

before(() => {
  if (!skip) ({ db, close } = createDb(url!, { max: 4 }));
});
after(async () => {
  if (!skip) await close();
});

function server() {
  return buildServer({
    db,
    redis: { ping: async () => 'PONG' },
    inbound: { add: async () => {} },
    meta: { appSecret: 's', verifyToken: 'v' },
    facebook: {} as never,
    graph: {
      sendText: async (_t, psid, text) => (sent.push({ to: psid, text }), ['mid-staff']),
      replyToComment: async (_t, commentId, text) => (sent.push({ to: commentId, text }), `c-staff-${sent.length}`),
      publishPost: async () => 'unused', publishVideo: async () => 'unused',
    },
    encryptionKey: key,
    urls: { web: WEB, api: 'https://api.agently.test' },
    cookies: { secure: true },
    enqueueKnowledge: async () => {},
  });
}

async function shop() {
  const [ws] = await db.insert(workspaces).values({ name: 'Shop', status: 'trial' }).returning();
  await db.insert(agents).values({ workspaceId: ws!.id, name: 'Mina' });
  const [user] = await db.insert(users).values({ name: 'Owner' }).returning();
  await db.insert(memberships).values({ workspaceId: ws!.id, userId: user!.id, role: 'owner' });
  const token = randomBytes(16).toString('hex');
  await db.insert(sessions).values({ userId: user!.id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 864e5) });
  const [channel] = await db
    .insert(channels)
    .values({ workspaceId: ws!.id, type: 'facebook_page', externalId: `page-${randomBytes(4).toString('hex')}`, name: 'Page', accessTokenEncrypted: encryptSecret('t', key) })
    .returning();
  const [customer] = await db.insert(customers).values({ workspaceId: ws!.id, name: 'Sadia Rahman', phone: '01712345678' }).returning();
  await db.insert(customerIdentities).values({ workspaceId: ws!.id, customerId: customer!.id, channelId: channel!.id, externalId: 'PSID-9' });
  const [conversation] = await db
    .insert(conversations)
    .values({ workspaceId: ws!.id, channelId: channel!.id, customerId: customer!.id, lastCustomerMessageAt: new Date(), mode: 'human' })
    .returning();
  const auth = { cookies: { agently_session: token }, headers: { origin: WEB } };
  return { ws: ws!, user: user!, channel: channel!, customer: customer!, conversation: conversation!, auth };
}

test('home: checklist, today numbers, channels and activity', { skip }, async () => {
  const app = server();
  const s = await shop();
  const [product] = await db.insert(products).values({ workspaceId: s.ws.id, title: 'Kurti', code: 'K-1', price: '1250' }).returning();
  const [variant] = await db.insert(productVariants).values({ workspaceId: s.ws.id, productId: product!.id, stock: 5 }).returning();
  await createOrder(db, { workspaceId: s.ws.id, customerId: s.customer.id }, { source: 'ai', items: [{ variantId: variant!.id, quantity: 1 }] });
  await db.insert(activities).values({ workspaceId: s.ws.id, type: 'test', text: 'Something happened' });

  const res = await app.inject({ url: `/api/workspaces/${s.ws.id}/home`, ...s.auth });
  assert.equal(res.statusCode, 200);
  const h = res.json();
  assert.deepEqual(h.setup, { pageConnected: true, products: 1, knowledgeSources: 0, paymentNumbers: false, agentLive: false });
  assert.equal(h.stats.needsYou, 1);
  assert.equal(h.stats.ordersToday, 1);
  assert.equal(h.stats.toShip, 0);
  assert.equal(Number(h.stats.revenueThisMonth), 1250);
  assert.equal(h.agent.name, 'Mina');
  assert.equal(h.channels.length, 1);
  assert.equal(typeof h.credits.granted, 'number');
  assert.ok(h.activity.some((a: { text: string }) => a.text === 'Something happened'));

  const ch = await app.inject({ url: `/api/workspaces/${s.ws.id}/channels`, ...s.auth });
  assert.deepEqual(ch.json().channels.map((c: { name: string }) => c.name), ['Page']);

  const feed = await app.inject({ url: `/api/workspaces/${s.ws.id}/activities?limit=1`, ...s.auth });
  assert.equal(feed.json().activities.length, 1);

  // Another shop can't see it.
  const other = await shop();
  assert.equal((await app.inject({ url: `/api/workspaces/${s.ws.id}/home`, ...other.auth })).statusCode, 404);
});

test('inbox: search by customer, and the customer panel shows their orders', { skip }, async () => {
  const app = server();
  const s = await shop();
  const base = `/api/workspaces/${s.ws.id}/conversations`;
  assert.equal((await app.inject({ url: `${base}?q=sadia`, ...s.auth })).json().conversations.length, 1);
  assert.equal((await app.inject({ url: `${base}?q=0171234`, ...s.auth })).json().conversations.length, 1);
  assert.equal((await app.inject({ url: `${base}?q=nobody`, ...s.auth })).json().conversations.length, 0);

  const [product] = await db.insert(products).values({ workspaceId: s.ws.id, title: 'Kurti', code: 'K-2', price: '900' }).returning();
  const [variant] = await db.insert(productVariants).values({ workspaceId: s.ws.id, productId: product!.id, stock: 5 }).returning();
  await createOrder(db, { workspaceId: s.ws.id, customerId: s.customer.id }, { source: 'ai', items: [{ variantId: variant!.id, quantity: 2 }] });
  const detail = (await app.inject({ url: `${base}/${s.conversation.id}`, ...s.auth })).json();
  assert.equal(detail.orders.length, 1);
  assert.equal(detail.orders[0].items[0].quantity, 2);
  assert.equal(detail.history.orders, 1);
});

test('comments: list with replies, filter, and a staff reply under one comment', { skip }, async () => {
  sent = [];
  const app = server();
  const s = await shop();
  const comment = async (text: string, ext: string) =>
    (
      await db
        .insert(messages)
        .values({ workspaceId: s.ws.id, conversationId: s.conversation.id, channelId: s.channel.id, direction: 'inbound', kind: 'comment', sender: 'customer', text, externalId: ext, delivery: 'received', meta: { postId: 'post-1', commentId: ext } })
        .returning()
    )[0]!;
  const answered = await comment('Dam koto?', 'c-1');
  await new Promise((r) => setTimeout(r, 5));
  const open = await comment('Exchange korbo kivabe?', 'c-2');
  await db.insert(messages).values({ workspaceId: s.ws.id, conversationId: s.conversation.id, channelId: s.channel.id, direction: 'outbound', kind: 'comment_reply', sender: 'ai', text: '৳1,250', externalId: 'r-1', delivery: 'sent', meta: { replyToMessageId: answered.id } });

  const base = `/api/workspaces/${s.ws.id}/comments`;
  const all = (await app.inject({ url: base, ...s.auth })).json();
  assert.deepEqual(all.comments.map((c: { text: string; replies: unknown[] }) => [c.text, c.replies.length]), [
    ['Exchange korbo kivabe?', 0],
    ['Dam koto?', 1],
  ]);
  assert.equal(all.comments[0].postId, 'post-1');
  assert.equal(all.comments[0].customer.name, 'Sadia Rahman');
  assert.deepEqual((await app.inject({ url: `${base}?filter=needs_you`, ...s.auth })).json().comments.map((c: { id: string }) => c.id), [open.id]);
  assert.deepEqual((await app.inject({ url: `${base}?filter=answered`, ...s.auth })).json().comments.map((c: { id: string }) => c.id), [answered.id]);

  // Replying to the older comment answers that one, not the latest.
  const r = await app.inject({ method: 'POST', url: `${base}/${answered.id}/reply`, payload: { text: 'Inbox e dekhun' }, ...s.auth });
  assert.equal(r.statusCode, 201);
  assert.deepEqual(sent, [{ to: 'c-1', text: 'Inbox e dekhun' }]);
  const reply = await app.inject({ method: 'POST', url: `${base}/${open.id}/reply`, payload: { text: 'Ji, 7 diner moddhe' }, ...s.auth });
  assert.equal(reply.json().message.meta.replyToMessageId, open.id);
  assert.equal((await app.inject({ url: `${base}?filter=needs_you`, ...s.auth })).json().comments.length, 0);

  const other = await shop();
  assert.equal((await app.inject({ method: 'POST', url: `/api/workspaces/${other.ws.id}/comments/${open.id}/reply`, payload: { text: 'x' }, ...other.auth })).statusCode, 404);
});

test('sign out ends the session', { skip }, async () => {
  const app = server();
  const s = await shop();
  assert.equal((await app.inject({ method: 'POST', url: '/api/logout', ...s.auth })).statusCode, 204);
  assert.equal((await app.inject({ url: '/api/me', ...s.auth })).statusCode, 401);
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, s.ws.id));
  assert.ok(row);
});
