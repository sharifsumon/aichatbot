/** WhatsApp and Instagram connections, their plan limits, and one chat agent per channel type. Needs DATABASE_URL. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { agents, authAccounts, channels, createDb, memberships, plans, sessions, users, workspaces, type Db, type PlanLimits } from '@agently/db';
import { GraphApiError, type InstagramAccount } from '@agently/meta';
import { decryptSecret, encryptSecret } from '@agently/shared';
import { buildServer } from '../server.ts';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL not set';
const WEB = 'https://app.agently.test';
const key = randomBytes(32).toString('base64');
let db: Db;
let close: () => Promise<void>;

before(() => {
  if (!skip) ({ db, close } = createDb(url!, { max: 4 }));
});
after(async () => {
  if (!skip) await close();
});

const digits = () => String(10_000_000 + Math.floor(Math.random() * 89_999_999)) + String(Date.now()).slice(-6);

function server(igAccounts: InstagramAccount[] = []) {
  const calls: string[] = [];
  const app = buildServer({
    db,
    redis: { ping: async () => 'PONG' },
    inbound: { add: async () => {} },
    meta: { appSecret: 's', verifyToken: 'v' },
    facebook: {
      pages: async () => [],
      subscribePage: async () => {},
      unsubscribePage: async (pageId: string) => void calls.push(`unsubscribe ${pageId}`),
      instagramAccounts: async (token: string) => {
        if (token !== 'user-token') throw new GraphApiError('no permission', 403, 10);
        return igAccounts;
      },
      subscribeInstagramPage: async (pageId: string) => void calls.push(`ig-subscribe ${pageId}`),
      exchangeSignupCode: async (code: string) => `business-token-${code}`,
    } as never,
    graph: {
      whatsAppNumber: async (token: string, id: string) => {
        if (token.startsWith('bad')) throw new GraphApiError('Invalid OAuth access token', 400, 190);
        return { id, displayPhoneNumber: '880 1700-000000', verifiedName: 'Rahim Fashion' };
      },
      subscribeWhatsApp: async (_token: string, wabaId: string) => void calls.push(`wa-subscribe ${wabaId}`),
      registerWhatsApp: async (_token: string, id: string) => void calls.push(`wa-register ${id}`),
    } as never,
    whatsappSignup: { appId: 'app', configId: 'cfg', version: 'v23.0' },
    encryptionKey: key,
    urls: { web: WEB, api: 'https://api.agently.test' },
    cookies: { secure: true },
    enqueueKnowledge: async () => {},
  });
  return { app, calls };
}

async function shop(limits: Partial<PlanLimits>) {
  const [p] = await db
    .insert(plans)
    .values({
      key: `test-${randomBytes(4).toString('hex')}`,
      name: 'Starter',
      priceBdt: '990',
      priceUsd: '9',
      limits: { pages: 1, agents: 3, aiCreditsPerMonth: 2000, knowledgeBaseMb: 100, staffSeats: 2, ...limits },
    })
    .returning();
  const [ws] = await db.insert(workspaces).values({ name: 'Rahim Fashion', status: 'trial', trialEndsAt: new Date(Date.now() + 7 * 864e5), planId: p!.id }).returning();
  const [user] = await db.insert(users).values({ name: 'Rahim' }).returning();
  const token = randomBytes(16).toString('hex');
  await db.insert(sessions).values({ userId: user!.id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 864e5) });
  await db.insert(memberships).values({ workspaceId: ws!.id, userId: user!.id, role: 'owner' });
  await db.insert(authAccounts).values({ userId: user!.id, provider: 'facebook', providerAccountId: `fb-${randomBytes(4).toString('hex')}`, accessTokenEncrypted: encryptSecret('user-token', key) });
  const [main] = await db.insert(agents).values({ workspaceId: ws!.id, name: 'Mina' }).returning();
  return { ws: ws!, main: main!, auth: { cookies: { agently_session: token }, headers: { origin: WEB } } };
}

test('a plan without WhatsApp or Instagram refuses them', { skip }, async () => {
  const { app } = server();
  const { ws, auth } = await shop({});
  const res = await app.inject({ method: 'POST', url: `/api/workspaces/${ws.id}/whatsapp/connect`, payload: { phoneNumberId: digits(), wabaId: digits(), accessToken: 'x'.repeat(40) }, ...auth });
  assert.equal(res.statusCode, 402);
  assert.match(res.json().error, /does not include WhatsApp numbers/);
  const usage = await app.inject({ url: `/api/workspaces/${ws.id}/channels/usage`, ...auth });
  assert.deepEqual(usage.json().usage.whatsapp, { used: 0, limit: 0 });
  assert.deepEqual(usage.json().usage.instagram, { used: 0, limit: 0 });
});

test('WhatsApp: connect by details or by signup, one number on Starter', { skip }, async () => {
  const { app, calls } = server();
  const { ws, auth } = await shop({ whatsappNumbers: 1, instagramAccounts: 1 });
  const base = `/api/workspaces/${ws.id}`;
  const phoneNumberId = digits();
  const wabaId = digits();

  const bad = await app.inject({ method: 'POST', url: `${base}/whatsapp/connect`, payload: { phoneNumberId, wabaId, accessToken: `bad-${'x'.repeat(30)}` }, ...auth });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /Invalid OAuth access token/);

  const ok = await app.inject({ method: 'POST', url: `${base}/whatsapp/connect`, payload: { phoneNumberId, wabaId, accessToken: `EAAG${'x'.repeat(40)}` }, ...auth });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json().channel.hasAgent, false);
  assert.deepEqual(calls, [`wa-subscribe ${wabaId}`]);
  const [ch] = await db.select().from(channels).where(eq(channels.externalId, phoneNumberId));
  assert.equal(ch!.type, 'whatsapp');
  assert.equal(ch!.name, 'Rahim Fashion (+880 1700-000000)');
  assert.deepEqual(ch!.meta, { wabaId, displayPhoneNumber: '+880 1700-000000' });
  assert.equal(decryptSecret(ch!.accessTokenEncrypted!, key), `EAAG${'x'.repeat(40)}`);

  // A second number doesn't fit Starter; reconnecting the first one does.
  const second = await app.inject({ method: 'POST', url: `${base}/whatsapp/signup`, payload: { code: 'signup-code-123', phoneNumberId: digits(), wabaId }, ...auth });
  assert.equal(second.statusCode, 402);
  assert.match(second.json().error, /allows 1 WhatsApp number\./);
  const again = await app.inject({ method: 'POST', url: `${base}/whatsapp/signup`, payload: { code: 'signup-code-123', phoneNumberId, wabaId }, ...auth });
  assert.equal(again.statusCode, 200);
  assert.ok(calls.includes(`wa-register ${phoneNumberId}`));
  const [after] = await db.select().from(channels).where(eq(channels.externalId, phoneNumberId));
  assert.equal(decryptSecret(after!.accessTokenEncrypted!, key), 'business-token-signup-code-123');

  const usage = await app.inject({ url: `${base}/channels/usage`, ...auth });
  assert.deepEqual(usage.json().usage.whatsapp, { used: 1, limit: 1 });
  assert.equal(usage.json().whatsappSignup.configId, 'cfg');
});

test('Instagram: lists linked accounts, connects one, and keeps its page subscribed', { skip }, async () => {
  const igId = digits();
  const pageId = digits();
  const { app, calls } = server([{ id: igId, username: 'rahim.fashion', page: { id: pageId, name: 'Rahim Fashion', accessToken: 'page-token', tasks: ['MESSAGING'] } }]);
  const { ws, main, auth } = await shop({ whatsappNumbers: 1, instagramAccounts: 1 });
  const base = `/api/workspaces/${ws.id}`;

  const list = await app.inject({ url: `${base}/instagram/accounts`, ...auth });
  assert.deepEqual(list.json().accounts, [{ id: igId, username: 'rahim.fashion', pageName: 'Rahim Fashion', canMessage: true, connected: null }]);

  const ok = await app.inject({ method: 'POST', url: `${base}/instagram/accounts/${igId}/connect`, ...auth });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().channel.name, '@rahim.fashion');
  assert.deepEqual(calls, [`ig-subscribe ${pageId}`]);
  const [ig] = await db.select().from(channels).where(eq(channels.externalId, igId));
  assert.deepEqual(ig!.meta, { pageId, pageName: 'Rahim Fashion', username: 'rahim.fashion' });
  assert.equal(ig!.agentId, null);

  // Disconnecting the same page as a Facebook channel leaves its subscription for Instagram.
  const [fb] = await db
    .insert(channels)
    .values({ workspaceId: ws.id, agentId: main.id, type: 'facebook_page', externalId: pageId, name: 'Rahim Fashion', accessTokenEncrypted: encryptSecret('page-token', key) })
    .returning();
  assert.equal((await app.inject({ method: 'POST', url: `${base}/channels/${fb!.id}/disconnect`, ...auth })).statusCode, 204);
  assert.ok(!calls.includes(`unsubscribe ${pageId}`));
});

test('chat agents: one per channel type, takes over its channels, limited by the plan', { skip }, async () => {
  const { app } = server();
  const { ws, main, auth } = await shop({ whatsappNumbers: 1, instagramAccounts: 1, agents: 2 });
  const base = `/api/workspaces/${ws.id}`;
  const phoneNumberId = digits();
  const [wa] = await db
    .insert(channels)
    .values({ workspaceId: ws.id, type: 'whatsapp', externalId: phoneNumberId, name: '+880 1700-000000', accessTokenEncrypted: encryptSecret('t', key) })
    .returning();

  let list = await app.inject({ url: `${base}/agents`, ...auth });
  assert.deepEqual(list.json().unanswered, ['whatsapp']);
  assert.deepEqual(list.json().agents.map((a: { channelType: string }) => a.channelType), ['facebook_page']);

  const created = await app.inject({ method: 'POST', url: `${base}/agents`, payload: { channelType: 'whatsapp' }, ...auth });
  assert.equal(created.statusCode, 201);
  const waAgent = created.json().agent;
  assert.equal(waAgent.name, 'Rahim Fashion WhatsApp assistant');
  assert.equal(waAgent.commentReplyMode, 'off');
  assert.equal((await db.select().from(channels).where(eq(channels.id, wa!.id)))[0]!.agentId, waAgent.id);

  assert.equal((await app.inject({ method: 'POST', url: `${base}/agents`, payload: { channelType: 'whatsapp' }, ...auth })).statusCode, 409);
  const over = await app.inject({ method: 'POST', url: `${base}/agents`, payload: { channelType: 'instagram' }, ...auth });
  assert.equal(over.statusCode, 402);

  // Live needs a connected channel of its own type.
  assert.equal((await app.inject({ method: 'PATCH', url: `${base}/agents/${waAgent.id}`, payload: { status: 'live', name: 'Mina on WhatsApp' }, ...auth })).statusCode, 200);
  list = await app.inject({ url: `${base}/agents`, ...auth });
  assert.deepEqual(list.json().unanswered, []);
  const listed = list.json().agents.find((a: { id: string }) => a.id === waAgent.id);
  assert.deepEqual([listed.name, listed.status, listed.channels.map((c: { id: string }) => c.id)], ['Mina on WhatsApp', 'live', [wa!.id]]);

  assert.equal((await app.inject({ method: 'DELETE', url: `${base}/agents/${main.id}`, ...auth })).statusCode, 409);
  assert.equal((await app.inject({ method: 'DELETE', url: `${base}/agents/${waAgent.id}`, ...auth })).statusCode, 204);
  assert.equal((await db.select().from(channels).where(eq(channels.id, wa!.id)))[0]!.agentId, null);

  // The old single-agent route still edits the main bot.
  const main2 = await app.inject({ url: `${base}/agent`, ...auth });
  assert.equal(main2.json().agent.id, main.id);
});
