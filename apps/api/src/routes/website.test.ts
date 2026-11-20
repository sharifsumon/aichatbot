/** Website chat: the opt-in setting, the snippet, and the widget's public chat calls. Needs DATABASE_URL. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  agents,
  channels,
  conversations,
  createDb,
  customerIdentities,
  customers,
  knowledgeSources,
  memberships,
  messages,
  sessions,
  users,
  workspaces,
  type Db,
} from '@agently/db';
import type { InboundJob, KnowledgeJob } from '@agently/shared';
import { buildServer } from '../server.ts';
import { originAllowed } from './widget-public.ts';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL not set';
const WEB = 'https://app.agently.test';
const API = 'https://api.agently.test';
let db: Db;
let close: () => Promise<void>;

before(() => {
  if (!skip) ({ db, close } = createDb(url!, { max: 4 }));
});
after(async () => {
  if (!skip) await close();
});

function server() {
  const queued: InboundJob[] = [];
  const crawls: KnowledgeJob[] = [];
  const app = buildServer({
    db,
    redis: { ping: async () => 'PONG' },
    inbound: { add: async (_name: string, job: InboundJob) => void queued.push(job) },
    meta: { appSecret: 's', verifyToken: 'v' },
    facebook: {} as never,
    graph: {} as never,
    encryptionKey: randomBytes(32).toString('base64'),
    urls: { web: WEB, api: API },
    cookies: { secure: true },
    enqueueKnowledge: async (job) => void crawls.push(job),
  });
  return { app, queued, crawls };
}

async function shop() {
  const [ws] = await db.insert(workspaces).values({ name: 'Rahim Fashion', status: 'trial', trialEndsAt: new Date(Date.now() + 7 * 864e5) }).returning();
  const [user] = await db.insert(users).values({ name: 'Rahim' }).returning();
  const token = randomBytes(16).toString('hex');
  await db.insert(sessions).values({ userId: user!.id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 864e5) });
  await db.insert(memberships).values({ workspaceId: ws!.id, userId: user!.id, role: 'owner' });
  const [main] = await db.insert(agents).values({ workspaceId: ws!.id, name: 'Mina' }).returning();
  return { ws: ws!, main: main!, auth: { cookies: { agently_session: token }, headers: { origin: WEB } } };
}

test('origin check: the site, www and subdomains only', () => {
  assert.equal(originAllowed('https://rahim.com.bd', 'https://www.rahim.com.bd/shop'), true);
  assert.equal(originAllowed('https://www.rahim.com.bd', 'https://rahim.com.bd'), true);
  assert.equal(originAllowed('https://shop.rahim.com.bd', 'https://rahim.com.bd'), true);
  assert.equal(originAllowed('https://evilrahim.com.bd', 'https://rahim.com.bd'), false);
  assert.equal(originAllowed('https://rahim.com.bd.evil.com', 'https://rahim.com.bd'), false);
  assert.equal(originAllowed(undefined, 'https://rahim.com.bd'), true);
});

test('website chat is off until ticked; turning it on makes the widget and crawls the site', { skip }, async () => {
  const { app, crawls } = server();
  const { ws, main, auth } = await shop();
  const base = `/api/workspaces/${ws.id}/website`;

  assert.deepEqual((await app.inject({ url: base, ...auth })).json(), { website: null });
  assert.equal((await app.inject({ method: 'PUT', url: base, payload: { enabled: true, url: 'not a url' }, ...auth })).statusCode, 400);

  const on = await app.inject({ method: 'PUT', url: base, payload: { enabled: true, url: 'https://www.rahim.com.bd/', welcomeMessage: 'Assalamu alaikum!' }, ...auth });
  assert.equal(on.statusCode, 200);
  const site = on.json().website;
  assert.equal(site.enabled, true);
  assert.match(site.key, /^wk_/);
  assert.equal(site.welcomeMessage, 'Assalamu alaikum!');
  assert.equal(site.snippet, `<script src="${API}/widget.js" data-agently-key="${site.key}" async></script>`);
  assert.equal(site.knowledge.status, 'queued');

  const [channel] = await db.select().from(channels).where(eq(channels.id, site.channelId));
  assert.equal(channel!.type, 'widget');
  assert.equal(channel!.agentId, main.id);
  const [source] = await db.select().from(knowledgeSources).where(eq(knowledgeSources.id, site.knowledge.id));
  assert.deepEqual([source!.type, source!.url, source!.name], ['website', 'https://www.rahim.com.bd/', 'Website: rahim.com.bd']);
  assert.deepEqual(crawls, [{ workspaceId: ws.id, sourceId: source!.id }]);

  // Saving again with the same address keeps the key and doesn't crawl again; a new address does.
  const same = await app.inject({ method: 'PUT', url: base, payload: { enabled: true, url: 'https://www.rahim.com.bd/', color: '#16a34a' }, ...auth });
  assert.equal(same.json().website.key, site.key);
  assert.equal(same.json().website.color, '#16a34a');
  assert.equal(same.json().website.welcomeMessage, 'Assalamu alaikum!');
  assert.equal(crawls.length, 1);
  await app.inject({ method: 'PUT', url: base, payload: { enabled: true, url: 'https://rahimfashion.com' }, ...auth });
  assert.equal(crawls.length, 2);
  assert.equal((await db.select().from(knowledgeSources).where(eq(knowledgeSources.workspaceId, ws.id))).length, 1);

  // The main bot may go live with only website chat.
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/workspaces/${ws.id}/agent`, payload: { status: 'live' }, ...auth })).statusCode, 200);
  const list = await app.inject({ url: `/api/workspaces/${ws.id}/agents`, ...auth });
  assert.deepEqual(list.json().unanswered, []);

  const off = await app.inject({ method: 'PUT', url: base, payload: { enabled: false }, ...auth });
  assert.equal(off.json().website.enabled, false);
  assert.equal((await app.inject({ url: `/widget/${site.key}/config`, headers: { origin: 'https://rahimfashion.com' } })).statusCode, 404);
});

test('the widget: config, sending a message, and reading replies', { skip }, async () => {
  const { app, queued } = server();
  const { ws, auth } = await shop();
  const site = (await app.inject({ method: 'PUT', url: `/api/workspaces/${ws.id}/website`, payload: { enabled: true, url: 'https://rahim.com.bd' }, ...auth })).json().website;
  const origin = { origin: 'https://www.rahim.com.bd' };

  const script = await app.inject({ url: '/widget.js' });
  assert.equal(script.statusCode, 200);
  assert.match(script.headers['content-type'] as string, /javascript/);
  assert.match(script.body, /data-agently-key/);

  const config = await app.inject({ url: `/widget/${site.key}/config`, headers: origin });
  assert.equal(config.statusCode, 200);
  assert.equal(config.headers['access-control-allow-origin'], 'https://www.rahim.com.bd');
  assert.deepEqual(config.json(), { name: 'Rahim Fashion', agentName: 'Mina', welcomeMessage: 'Hi! How can we help you today?', color: '#2563eb', botOnline: false });

  // Other sites can't use the shop's widget.
  assert.equal((await app.inject({ url: `/widget/${site.key}/config`, headers: { origin: 'https://other.com' } })).statusCode, 404);
  assert.equal((await app.inject({ url: '/widget/wk_doesnotexist123/config' })).statusCode, 404);

  const preflight = await app.inject({ method: 'OPTIONS', url: `/widget/${site.key}/messages`, headers: { ...origin, 'access-control-request-method': 'POST' } });
  assert.equal(preflight.statusCode, 204);

  const visitorId = `v_${randomBytes(12).toString('hex')}`;
  assert.equal((await app.inject({ method: 'POST', url: `/widget/${site.key}/messages`, headers: origin, payload: { visitorId: 'x', text: 'hi' } })).statusCode, 400);
  const sent = await app.inject({ method: 'POST', url: `/widget/${site.key}/messages`, headers: origin, payload: { visitorId, text: 'Do you deliver to Sylhet?' } });
  assert.equal(sent.statusCode, 202);
  assert.equal(queued.length, 1);
  assert.deepEqual(
    { channel: queued[0]!.channel, channelExternalId: queued[0]!.channelExternalId, senderExternalId: queued[0]!.senderExternalId, text: queued[0]!.text, externalId: queued[0]!.externalId },
    { channel: 'widget', channelExternalId: site.key, senderExternalId: visitorId, text: 'Do you deliver to Sylhet?', externalId: sent.json().id },
  );

  // Nothing saved yet: an empty conversation.
  assert.deepEqual((await app.inject({ url: `/widget/${site.key}/messages?visitorId=${visitorId}`, headers: origin })).json(), { messages: [], waiting: false });

  // What the worker saves (the inbound message and the bot's reply), and a staff reply from the inbox.
  const [customer] = await db.insert(customers).values({ workspaceId: ws.id, name: 'Website visitor' }).returning();
  await db.insert(customerIdentities).values({ workspaceId: ws.id, customerId: customer!.id, channelId: site.channelId, externalId: visitorId });
  const [conv] = await db.insert(conversations).values({ workspaceId: ws.id, channelId: site.channelId, customerId: customer!.id, lastCustomerMessageAt: new Date(Date.now() - 3 * 864e5) }).returning();
  const t = Date.now() - 60_000;
  await db.insert(messages).values([
    { workspaceId: ws.id, conversationId: conv!.id, channelId: site.channelId, direction: 'inbound', sender: 'customer', text: 'Do you deliver to Sylhet?', externalId: sent.json().id, delivery: 'received', createdAt: new Date(t) },
    { workspaceId: ws.id, conversationId: conv!.id, channelId: site.channelId, direction: 'outbound', sender: 'ai', text: 'Yes, in 3 days.', externalId: 'a1', delivery: 'sent', createdAt: new Date(t + 1000) },
  ]);
  const read = (await app.inject({ url: `/widget/${site.key}/messages?visitorId=${visitorId}`, headers: origin })).json();
  assert.deepEqual(read.messages.map((m: { from: string; text: string; ref: string | null }) => [m.from, m.text, m.ref]), [
    ['visitor', 'Do you deliver to Sylhet?', sent.json().id],
    ['bot', 'Yes, in 3 days.', null],
  ]);
  assert.equal(read.waiting, false);

  // Staff can answer website chats days later: there is no 24-hour window.
  const detail = await app.inject({ url: `/api/workspaces/${ws.id}/conversations/${conv!.id}`, ...auth });
  assert.equal(detail.json().conversation.canReply, true);
  const staff = await app.inject({ method: 'POST', url: `/api/workspaces/${ws.id}/conversations/${conv!.id}/reply`, payload: { text: 'Hi, Rahim here.' }, ...auth });
  assert.equal(staff.statusCode, 201);
  const later = (await app.inject({ url: `/widget/${site.key}/messages?visitorId=${visitorId}&after=${encodeURIComponent(read.messages[1].at)}`, headers: origin })).json();
  assert.deepEqual(later.messages.map((m: { from: string; text: string }) => [m.from, m.text]), [['bot', 'Yes, in 3 days.'], ['staff', 'Hi, Rahim here.']]);

  // Another visitor sees nothing of it.
  assert.deepEqual((await app.inject({ url: `/widget/${site.key}/messages?visitorId=v_${randomBytes(12).toString('hex')}`, headers: origin })).json().messages, []);
});
