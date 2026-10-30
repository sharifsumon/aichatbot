/** Inbox and Orders CRM routes against a real database. Needs DATABASE_URL. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createOrder, setDeliveryDetails, setPaymentMethod, submitTransactionId } from '@agently/commerce';
import {
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
import { GraphApiError } from '@agently/meta';
import { encryptSecret } from '@agently/shared';
import { buildServer } from '../server.ts';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL not set';
const key = randomBytes(32).toString('base64');
const WEB = 'https://app.agently.test';
let db: Db;
let close: () => Promise<void>;
let sent: { to: string; text: string }[] = [];
let failNext: GraphApiError | undefined;

before(() => {
  if (!skip) ({ db, close } = createDb(url!, { max: 4 }));
});
after(async () => {
  if (!skip) await close();
});

function server() {
  const take = () => {
    const e = failNext;
    failNext = undefined;
    if (e) throw e;
  };
  return buildServer({
    db,
    redis: { ping: async () => 'PONG' },
    inbound: { add: async () => {} },
    meta: { appSecret: 's', verifyToken: 'v' },
    facebook: {} as never,
    graph: {
      sendText: async (_t, psid, text) => (take(), sent.push({ to: psid, text }), ['mid-staff']),
      replyToComment: async (_t, commentId, text) => (take(), sent.push({ to: commentId, text }), 'c-staff'),
    },
    encryptionKey: key,
    urls: { web: WEB, api: 'https://api.agently.test' },
    cookies: { secure: true },
  });
}

/** A shop with a staff member signed in, a connected page, and one customer chat. */
async function shop(role: 'owner' | 'agent' = 'agent') {
  const [ws] = await db.insert(workspaces).values({ name: 'Shop', status: 'active' }).returning();
  const [user] = await db.insert(users).values({ name: 'Staff' }).returning();
  await db.insert(memberships).values({ workspaceId: ws!.id, userId: user!.id, role });
  const token = randomBytes(16).toString('hex');
  await db.insert(sessions).values({ userId: user!.id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 864e5) });
  const [channel] = await db
    .insert(channels)
    .values({ workspaceId: ws!.id, type: 'facebook_page', externalId: `page-${randomBytes(4).toString('hex')}`, name: 'Page', accessTokenEncrypted: encryptSecret('page-token', key) })
    .returning();
  const [customer] = await db.insert(customers).values({ workspaceId: ws!.id, name: 'Rahim' }).returning();
  await db.insert(customerIdentities).values({ workspaceId: ws!.id, customerId: customer!.id, channelId: channel!.id, externalId: 'PSID-1' });
  const [conversation] = await db
    .insert(conversations)
    .values({ workspaceId: ws!.id, channelId: channel!.id, customerId: customer!.id, lastCustomerMessageAt: new Date(), lastMessageAt: new Date() })
    .returning();
  await db.insert(messages).values({ workspaceId: ws!.id, conversationId: conversation!.id, channelId: channel!.id, direction: 'inbound', sender: 'customer', text: 'দাম কত?', externalId: `m-${randomBytes(4).toString('hex')}`, delivery: 'received' });
  const auth = { cookies: { agently_session: token }, headers: { origin: WEB } };
  return { ws: ws!, user: user!, channel: channel!, customer: customer!, conversation: conversation!, auth };
}

test('inbox: list, read, take over, reply as staff, return to AI', { skip }, async () => {
  sent = [];
  const app = server();
  const s = await shop();
  const base = `/api/workspaces/${s.ws.id}/conversations`;

  const list = await app.inject({ url: base, ...s.auth });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json().conversations.map((c: { id: string; preview: string; customer: { name: string } }) => [c.id, c.preview, c.customer.name]), [
    [s.conversation.id, 'দাম কত?', 'Rahim'],
  ]);

  const detail = await app.inject({ url: `${base}/${s.conversation.id}`, ...s.auth });
  assert.equal(detail.json().conversation.canReply, true);
  assert.equal(detail.json().messages.length, 1);

  assert.equal((await app.inject({ method: 'POST', url: `${base}/${s.conversation.id}/reply`, payload: { text: '  ' }, ...s.auth })).statusCode, 400);

  const replied = await app.inject({ method: 'POST', url: `${base}/${s.conversation.id}/reply`, payload: { text: 'ভাই, ৮৫০ টাকা।' }, ...s.auth });
  assert.equal(replied.statusCode, 201);
  assert.deepEqual(sent, [{ to: 'PSID-1', text: 'ভাই, ৮৫০ টাকা।' }]);
  let [conv] = await db.select().from(conversations).where(eq(conversations.id, s.conversation.id));
  assert.equal(conv!.mode, 'human');
  assert.equal(conv!.assignedUserId, s.user.id);
  const humanOnly = await app.inject({ url: `${base}?mode=human`, ...s.auth });
  assert.equal(humanOnly.json().conversations.length, 1);

  assert.equal((await app.inject({ method: 'POST', url: `${base}/${s.conversation.id}/return-to-ai`, ...s.auth })).statusCode, 204);
  [conv] = await db.select().from(conversations).where(eq(conversations.id, s.conversation.id));
  assert.equal(conv!.mode, 'ai');

  assert.equal((await app.inject({ method: 'POST', url: `${base}/${s.conversation.id}/takeover`, ...s.auth })).statusCode, 204);
  [conv] = await db.select().from(conversations).where(eq(conversations.id, s.conversation.id));
  assert.equal(conv!.mode, 'human');
});

test("inbox: no reply after Meta's 24-hour window; expired page token is flagged", { skip }, async () => {
  sent = [];
  const app = server();
  const s = await shop();
  const replyUrl = `/api/workspaces/${s.ws.id}/conversations/${s.conversation.id}/reply`;

  failNext = new GraphApiError('Session has expired', 400, 190);
  assert.equal((await app.inject({ method: 'POST', url: replyUrl, payload: { text: 'hi' }, ...s.auth })).statusCode, 502);
  const [channel] = await db.select().from(channels).where(eq(channels.id, s.channel.id));
  assert.equal(channel!.status, 'token_expired');
  await db.update(channels).set({ status: 'connected' }).where(eq(channels.id, s.channel.id));

  await db.update(conversations).set({ lastCustomerMessageAt: new Date(Date.now() - 25 * 3600 * 1000) }).where(eq(conversations.id, s.conversation.id));
  const late = await app.inject({ method: 'POST', url: replyUrl, payload: { text: 'hi' }, ...s.auth });
  assert.equal(late.statusCode, 409);
  assert.match(late.json().error, /24 hours/);
  assert.equal(sent.length, 0);
});

test("inbox and orders: another shop's staff get 404", { skip }, async () => {
  const app = server();
  const a = await shop();
  const b = await shop();
  assert.equal((await app.inject({ url: `/api/workspaces/${a.ws.id}/conversations`, ...b.auth })).statusCode, 404);
  // Right workspace in the URL, someone else's conversation id.
  assert.equal((await app.inject({ url: `/api/workspaces/${b.ws.id}/conversations/${a.conversation.id}`, ...b.auth })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: `/api/workspaces/${b.ws.id}/conversations/${a.conversation.id}/takeover`, ...b.auth })).statusCode, 404);
  assert.equal((await app.inject({ url: `/api/workspaces/${a.ws.id}/orders`, ...b.auth })).statusCode, 404);
});

test('orders: list, filter, search, verify a bKash payment, ship, deliver', { skip }, async () => {
  const app = server();
  const s = await shop();
  await db.update(workspaces).set({ bkashNumber: '01811111111' }).where(eq(workspaces.id, s.ws.id));
  const [product] = await db.insert(products).values({ workspaceId: s.ws.id, title: 'Shirt', code: 'SH-1', price: '850' }).returning();
  const [variant] = await db.insert(productVariants).values({ workspaceId: s.ws.id, productId: product!.id, stock: 5 }).returning();
  const scope = { workspaceId: s.ws.id, customerId: s.customer.id };
  const details = { customerName: 'Rahim Uddin', phone: '01712345678', address: 'House 5, Road 2, Dhanmondi', zone: 'inside_dhaka' as const };

  const paid = await createOrder(db, scope, { source: 'ai', items: [{ variantId: variant!.id, quantity: 1 }] });
  await setDeliveryDetails(db, scope, { number: paid.number, ...details });
  await setPaymentMethod(db, scope, { number: paid.number, method: 'bkash' });
  await submitTransactionId(db, scope, { number: paid.number, transactionId: `TRX${randomBytes(4).toString('hex')}` });
  const open = await createOrder(db, scope, { source: 'ai', items: [{ variantId: variant!.id, quantity: 2 }] });

  const base = `/api/workspaces/${s.ws.id}/orders`;
  const all = await app.inject({ url: base, ...s.auth });
  assert.deepEqual(all.json().orders.map((o: { number: number }) => o.number), [open.number, paid.number]);
  assert.equal(all.json().orders[1].items[0].quantity, 1);

  const toVerify = await app.inject({ url: `${base}?payment=pending_verification`, ...s.auth });
  assert.deepEqual(toVerify.json().orders.map((o: { id: string }) => o.id), [paid.id]);
  assert.deepEqual((await app.inject({ url: `${base}?q=${encodeURIComponent('#' + paid.number)}`, ...s.auth })).json().orders.map((o: { id: string }) => o.id), [paid.id]);
  assert.equal((await app.inject({ url: `${base}?q=rahim`, ...s.auth })).json().orders.length, 1);

  const page1 = await app.inject({ url: `${base}?limit=1`, ...s.auth });
  const page2 = await app.inject({ url: `${base}?limit=1&cursor=${encodeURIComponent(page1.json().nextCursor)}`, ...s.auth });
  assert.deepEqual(page2.json().orders.map((o: { id: string }) => o.id), [paid.id]);
  assert.equal(page2.json().nextCursor, null);

  const summary = await app.inject({ url: `${base}/summary`, ...s.auth });
  assert.equal(summary.json().byStatus.confirmed, 2);
  assert.equal(summary.json().byPayment.pending_verification, 1);

  const verified = await app.inject({ method: 'POST', url: `${base}/${paid.id}/verify-payment`, payload: { found: true }, ...s.auth });
  assert.equal(verified.json().order.paymentStatus, 'paid');
  const again = await app.inject({ method: 'POST', url: `${base}/${paid.id}/verify-payment`, payload: { found: true }, ...s.auth });
  assert.equal(again.statusCode, 409);

  // The other order is still waiting for an address, so it can't ship.
  const early = await app.inject({ method: 'POST', url: `${base}/${open.id}/ship`, ...s.auth });
  assert.equal(early.statusCode, 409);
  assert.equal(early.json().code, 'not_shippable');

  const shipped = await app.inject({
    method: 'POST',
    url: `${base}/${paid.id}/ship`,
    payload: { courier: 'Steadfast', consignmentId: 'SF1', trackingUrl: 'javascript:alert(1)' },
    ...s.auth,
  });
  assert.equal(shipped.json().order.status, 'shipped');
  assert.equal(shipped.json().order.trackingUrl, null);
  assert.equal((await app.inject({ method: 'POST', url: `${base}/${paid.id}/deliver`, ...s.auth })).json().order.status, 'delivered');

  const detail = await app.inject({ url: `${base}/${paid.id}`, ...s.auth });
  assert.equal(detail.json().order.customer.name, 'Rahim');
  assert.equal(detail.json().order.items.length, 1);

  assert.equal((await app.inject({ method: 'POST', url: `${base}/${open.id}/cancel`, ...s.auth })).json().order.status, 'cancelled');
  const [v] = await db.select().from(productVariants).where(eq(productVariants.id, variant!.id));
  assert.equal(v!.stock, 4);
});
