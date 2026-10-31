/** The super admin API against a real database. Needs DATABASE_URL. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  auditLogs,
  channels,
  conversations,
  createDb,
  creditGrants,
  customerIdentities,
  customers,
  memberships,
  messages,
  plans,
  platformSessions,
  platformUsers,
  sessions,
  usageRecords,
  users,
  workspaces,
  type Db,
} from '@agently/db';
import { encryptSecret, hashPassword, totpCode, totpStep } from '@agently/shared';
import { buildServer } from '../server.ts';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL not set';
const ADMIN = 'https://admin.agently.test';
const WEB = 'https://app.agently.test';
const key = randomBytes(32).toString('base64');
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
      sendText: async (_t, psid, text) => (sent.push({ to: psid, text }), ['mid-support']),
      replyToComment: async (_t, id, text) => (sent.push({ to: id, text }), 'c-support'),
    },
    encryptionKey: key,
    urls: { web: WEB, api: 'https://api.agently.test', admin: ADMIN },
    cookies: { secure: true },
    enqueueKnowledge: async () => {},
  });
}

const email = () => `${randomBytes(4).toString('hex')}@agently.test`;

/** A team member with a verified session, skipping the sign-in steps. */
async function admin(role: 'super_admin' | 'support' | 'finance') {
  const [user] = await db.insert(platformUsers).values({ name: role, email: email(), role, passwordHash: 'x', totpConfirmedAt: new Date() }).returning();
  const token = randomBytes(16).toString('hex');
  await db.insert(platformSessions).values({ platformUserId: user!.id, tokenHash: createHash('sha256').update(token).digest('hex'), verified: true, expiresAt: new Date(Date.now() + 3600_000) });
  return { user: user!, auth: { cookies: { agently_admin: token }, headers: { origin: ADMIN } } };
}

/** A shop with an owner, a connected page and one Messenger chat with a phone number in it. */
async function tenant() {
  const [ws] = await db.insert(workspaces).values({ name: `Shop ${randomBytes(3).toString('hex')}`, status: 'trial', trialEndsAt: new Date(Date.now() + 5 * 864e5) }).returning();
  const [owner] = await db.insert(users).values({ name: 'Owner', email: email() }).returning();
  await db.insert(memberships).values({ workspaceId: ws!.id, userId: owner!.id, role: 'owner' });
  const [channel] = await db
    .insert(channels)
    .values({ workspaceId: ws!.id, type: 'facebook_page', externalId: `pg-${randomBytes(4).toString('hex')}`, name: 'Page', accessTokenEncrypted: encryptSecret('page-token', key) })
    .returning();
  const [customer] = await db.insert(customers).values({ workspaceId: ws!.id, name: 'Rahim', phone: '01712345678', address: 'House 12, Road 5, Dhanmondi, Dhaka' }).returning();
  await db.insert(customerIdentities).values({ workspaceId: ws!.id, customerId: customer!.id, channelId: channel!.id, externalId: 'PSID-9' });
  const [conv] = await db
    .insert(conversations)
    .values({ workspaceId: ws!.id, channelId: channel!.id, customerId: customer!.id, lastCustomerMessageAt: new Date(), lastMessageAt: new Date() })
    .returning();
  await db.insert(messages).values({ workspaceId: ws!.id, conversationId: conv!.id, channelId: channel!.id, direction: 'inbound', sender: 'customer', text: 'আমার নম্বর 01712345678, পাঠিয়ে দিন', externalId: `m-${randomBytes(4).toString('hex')}`, delivery: 'received' });
  return { ws: ws!, owner: owner!, conv: conv! };
}

async function auditFor(adminId: string) {
  return (await db.select().from(auditLogs).where(eq(auditLogs.platformUserId, adminId))).map((a) => a.action);
}

test('sign-in: password, then authenticator setup; later sign-ins need a fresh code', { skip }, async () => {
  const app = server();
  const addr = email();
  await db.insert(platformUsers).values({ name: 'Sharif', email: addr, role: 'super_admin', passwordHash: await hashPassword('a long admin password') });
  const post = (path: string, payload: object, cookie?: string) =>
    app.inject({ method: 'POST', url: `/admin${path}`, payload, headers: { origin: ADMIN }, cookies: cookie ? { agently_admin: cookie } : {} });
  const cookieOf = (res: { cookies: { name: string; value: string }[] }) => res.cookies.find((c) => c.name === 'agently_admin')!.value;

  assert.equal((await post('/auth/login', { email: addr, password: 'wrong password!!' })).statusCode, 401);
  assert.equal((await post('/auth/login', { email: 'nobody@agently.test', password: 'whatever' })).statusCode, 401);

  const login = await post('/auth/login', { email: addr.toUpperCase(), password: 'a long admin password' });
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().next, 'totp_setup');
  const secret: string = login.json().secret;
  assert.match(login.json().otpauthUrl, /^otpauth:\/\/totp\//);
  const pending = cookieOf(login);
  // A pending session can't use the API.
  assert.equal((await app.inject({ url: '/admin/tenants', cookies: { agently_admin: pending } })).statusCode, 401);

  assert.equal((await post('/auth/totp', { code: '000000' }, pending)).statusCode, 401);
  const ok = await post('/auth/totp', { code: totpCode(secret, totpStep()) }, pending);
  assert.equal(ok.statusCode, 200);
  const session = cookieOf(ok);
  assert.notEqual(session, pending);
  assert.equal((await app.inject({ url: '/admin/auth/me', cookies: { agently_admin: session } })).json().admin.email, addr);
  assert.equal((await app.inject({ url: '/admin/tenants', cookies: { agently_admin: pending } })).statusCode, 401);

  // Second sign-in: the same code can't be used again.
  const again = await post('/auth/login', { email: addr, password: 'a long admin password' });
  assert.equal(again.json().next, 'totp');
  assert.equal(again.json().secret, undefined);
  const replay = await post('/auth/totp', { code: totpCode(secret, totpStep()) }, cookieOf(again));
  assert.equal(replay.statusCode, 401);
  const next = await post('/auth/totp', { code: totpCode(secret, totpStep() + 1) }, cookieOf(again));
  assert.equal(next.statusCode, 200);

  const [row] = await db.select().from(platformUsers).where(eq(platformUsers.email, addr));
  assert.deepEqual(await auditFor(row!.id), ['auth.2fa_enrolled', 'auth.signed_in']);
});

test('sign-in: five wrong passwords lock the account', { skip }, async () => {
  const app = server();
  const addr = email();
  await db.insert(platformUsers).values({ name: 'X', email: addr, role: 'support', passwordHash: await hashPassword('the right password') });
  for (let i = 0; i < 5; i++) {
    await app.inject({ method: 'POST', url: '/admin/auth/login', payload: { email: addr, password: 'the wrong password' }, headers: { origin: ADMIN } });
  }
  const locked = await app.inject({ method: 'POST', url: '/admin/auth/login', payload: { email: addr, password: 'the right password' }, headers: { origin: ADMIN } });
  assert.equal(locked.statusCode, 429);
});

test('the admin API refuses shop sessions, other origins and the wrong role', { skip }, async () => {
  const app = server();
  const t = await tenant();
  const token = randomBytes(16).toString('hex');
  await db.insert(sessions).values({ userId: t.owner.id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 864e5) });
  assert.equal((await app.inject({ url: '/admin/tenants', cookies: { agently_session: token } })).statusCode, 401);
  // Even with the shop token placed in the admin cookie.
  assert.equal((await app.inject({ url: '/admin/tenants', cookies: { agently_admin: token } })).statusCode, 401);

  const support = await admin('support');
  assert.equal((await app.inject({ method: 'POST', url: `/admin/tenants/${t.ws.id}/suspend`, payload: { reason: 'spam' }, cookies: support.auth.cookies, headers: { origin: WEB } })).statusCode, 403);
  // Support: no billing. Finance: no chats. Neither: audit or team.
  assert.equal((await app.inject({ method: 'POST', url: `/admin/tenants/${t.ws.id}/credits`, payload: { credits: 10, note: 'test' }, ...support.auth })).statusCode, 403);
  const finance = await admin('finance');
  assert.equal((await app.inject({ url: `/admin/conversations/${t.conv.id}`, ...finance.auth })).statusCode, 403);
  assert.equal((await app.inject({ url: '/admin/audit', ...finance.auth })).statusCode, 403);
  assert.equal((await app.inject({ url: '/admin/team', ...support.auth })).statusCode, 403);
  assert.equal((await app.inject({ url: '/admin/tenants', ...finance.auth })).statusCode, 200);
});

test('tenants: search, detail is audited, suspend shows the owner why, reactivate, extend trial', { skip }, async () => {
  const app = server();
  const t = await tenant();
  const support = await admin('support');

  const list = await app.inject({ url: `/admin/tenants?q=${encodeURIComponent(t.ws.name)}`, ...support.auth });
  assert.equal(list.statusCode, 200);
  const row = list.json().tenants[0];
  assert.equal(row.id, t.ws.id);
  assert.equal(row.owner.name, 'Owner');
  assert.equal(row.pagesConnected, 1);
  assert.ok(row.lastActiveAt);

  const detail = await app.inject({ url: `/admin/tenants/${t.ws.id}`, ...support.auth });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().members.length, 1);
  assert.equal(detail.json().channels.length, 1);

  assert.equal((await app.inject({ method: 'POST', url: `/admin/tenants/${t.ws.id}/suspend`, payload: { reason: 'Selling counterfeit goods' }, ...support.auth })).statusCode, 204);
  let [ws] = await db.select().from(workspaces).where(eq(workspaces.id, t.ws.id));
  assert.equal(ws!.status, 'suspended');
  assert.equal(ws!.suspendedReason, 'Selling counterfeit goods');

  const re = await app.inject({ method: 'POST', url: `/admin/tenants/${t.ws.id}/reactivate`, ...support.auth });
  assert.equal(re.json().status, 'trial');

  const before = ws!.trialEndsAt!;
  const ext = await app.inject({ method: 'POST', url: `/admin/tenants/${t.ws.id}/extend-trial`, payload: { days: 7 }, ...support.auth });
  assert.equal(ext.statusCode, 200);
  [ws] = await db.select().from(workspaces).where(eq(workspaces.id, t.ws.id));
  assert.equal(ws!.trialEndsAt!.getTime() - before.getTime(), 7 * 864e5);

  assert.deepEqual(await auditFor(support.user.id), ['tenant.viewed', 'tenant.suspended', 'tenant.reactivated', 'tenant.trial_extended']);
});

test('billing: change plan tops up this month, credits adjust with a note', { skip }, async () => {
  const app = server();
  const t = await tenant();
  const finance = await admin('finance');
  const [growth] = await db
    .insert(plans)
    .values({ key: `growth-${randomBytes(3).toString('hex')}`, name: 'Growth', priceBdt: '2490', priceUsd: '25', limits: { pages: 3, agents: 3, aiCreditsPerMonth: 8000, knowledgeBaseMb: 500, staffSeats: 5 } })
    .returning();

  const changed = await app.inject({ method: 'POST', url: `/admin/tenants/${t.ws.id}/plan`, payload: { planKey: growth!.key }, ...finance.auth });
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.json().creditsAdded, 8000);
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, t.ws.id));
  assert.equal(ws!.status, 'active');
  // Changing to the same plan again adds nothing.
  assert.equal((await app.inject({ method: 'POST', url: `/admin/tenants/${t.ws.id}/plan`, payload: { planKey: growth!.key }, ...finance.auth })).json().creditsAdded, 0);

  const adj = await app.inject({ method: 'POST', url: `/admin/tenants/${t.ws.id}/credits`, payload: { credits: 500, note: 'Sorry for the outage' }, ...finance.auth });
  assert.equal(adj.statusCode, 201);
  assert.equal(adj.json().credits.granted, 8500);
  const grants = await db.select().from(creditGrants).where(and(eq(creditGrants.workspaceId, t.ws.id), eq(creditGrants.reason, 'adjustment')));
  assert.equal(grants[0]!.grantedByPlatformUserId, finance.user.id);
  assert.equal((await app.inject({ method: 'POST', url: `/admin/tenants/${t.ws.id}/credits`, payload: { credits: 5 }, ...finance.auth })).statusCode, 400);
});

test('conversations: masked by default, reveal and reply are audited, reply is labelled support', { skip }, async () => {
  sent = [];
  const app = server();
  const t = await tenant();
  const support = await admin('support');

  const list = await app.inject({ url: `/admin/conversations?workspaceId=${t.ws.id}`, ...support.auth });
  assert.equal(list.json().conversations.length, 1);
  assert.match(list.json().conversations[0].preview, /017•••••678/);

  const masked = await app.inject({ url: `/admin/conversations/${t.conv.id}`, ...support.auth });
  assert.equal(masked.json().masked, true);
  assert.equal(masked.json().conversation.customer.phone, '017•••••678');
  assert.equal(masked.json().conversation.customer.address, '••••, Dhaka');
  assert.doesNotMatch(masked.json().messages[0].text, /01712345678/);

  const revealed = await app.inject({ url: `/admin/conversations/${t.conv.id}?reveal=true`, ...support.auth });
  assert.equal(revealed.json().conversation.customer.phone, '01712345678');
  assert.match(revealed.json().messages[0].text, /01712345678/);

  const replied = await app.inject({ method: 'POST', url: `/admin/conversations/${t.conv.id}/reply`, payload: { text: 'Agently support here, we are looking into it.' }, ...support.auth });
  assert.equal(replied.statusCode, 201);
  assert.equal(replied.json().message.sender, 'support');
  assert.equal(replied.json().message.meta.supportUserId, support.user.id);
  assert.deepEqual(sent, [{ to: 'PSID-9', text: 'Agently support here, we are looking into it.' }]);
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, t.conv.id));
  assert.equal(conv!.mode, 'human');

  assert.deepEqual(await auditFor(support.user.id), ['conversation.viewed', 'conversation.revealed', 'conversation.replied']);
});

test('overview and AI usage: tiles, top tenants, shops near their limit', { skip }, async () => {
  const app = server();
  const t = await tenant();
  const boss = await admin('super_admin');
  const monthEnd = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1));
  await db.insert(creditGrants).values({ workspaceId: t.ws.id, reason: 'plan', credits: 100, expiresAt: monthEnd });
  await db.insert(usageRecords).values({ workspaceId: t.ws.id, day: new Date().toISOString().slice(0, 10), model: 'test-model', aiReplies: 95, inputTokens: 1000, outputTokens: 200, costUsd: '0.5', failedCalls: 5 });

  const overview = await app.inject({ url: '/admin/overview', ...boss.auth });
  assert.equal(overview.statusCode, 200);
  const o = overview.json();
  assert.ok(o.tenants.trial >= 1);
  assert.ok(o.today.aiReplies >= 95);
  assert.ok(o.today.customerMessages >= 1);
  assert.ok(Number(o.aiCostThisMonthUsd) >= 0.5);

  const usage = await app.inject({ url: '/admin/usage?days=7', ...boss.auth });
  const u = usage.json();
  assert.ok(u.models.some((m: { model: string }) => m.model === 'test-model'));
  assert.ok(u.topTenants.some((x: { workspaceId: string }) => x.workspaceId === t.ws.id));
  const near = u.nearLimit.find((x: { workspaceId: string }) => x.workspaceId === t.ws.id);
  assert.deepEqual([near.used, near.granted, near.percentUsed], [95, 100, 95]);
});

test('team, plans, settings and flags; the last super admin stays', { skip }, async () => {
  const app = server();
  const boss = await admin('super_admin');

  const added = await app.inject({ method: 'POST', url: '/admin/team', payload: { name: 'Nadia', email: email(), role: 'support' }, ...boss.auth });
  assert.equal(added.statusCode, 201);
  assert.ok(added.json().temporaryPassword.length >= 20);
  const nadia = added.json().member.id;
  assert.equal((await app.inject({ method: 'PATCH', url: `/admin/team/${nadia}`, payload: { disabled: true }, ...boss.auth })).statusCode, 204);
  assert.equal((await app.inject({ method: 'PATCH', url: `/admin/team/${boss.user.id}`, payload: { role: 'support' }, ...boss.auth })).statusCode, 409);

  const plan = await app.inject({
    method: 'POST',
    url: '/admin/plans',
    payload: { key: `pro-${randomBytes(3).toString('hex')}`, name: 'Pro', priceBdt: 5990, priceUsd: '59', limits: { pages: 10, agents: 10, aiCreditsPerMonth: 25000, knowledgeBaseMb: 2048, staffSeats: 15 } },
    ...boss.auth,
  });
  assert.equal(plan.statusCode, 201);
  const edited = await app.inject({ method: 'PATCH', url: `/admin/plans/${plan.json().plan.id}`, payload: { priceBdt: '6490' }, ...boss.auth });
  assert.equal(edited.json().plan.priceBdt, '6490.00');

  assert.equal((await app.inject({ method: 'PUT', url: '/admin/settings/ai.defaultModel', payload: { value: 'gpt-4o-mini' }, ...boss.auth })).statusCode, 200);
  assert.equal((await app.inject({ method: 'PUT', url: '/admin/settings/ai.whatever', payload: { value: 1 }, ...boss.auth })).statusCode, 404);
  assert.equal((await app.inject({ url: '/admin/settings', ...boss.auth })).json().settings['ai.defaultModel'], 'gpt-4o-mini');

  const flagKey = `test.flag-${randomBytes(3).toString('hex')}`;
  assert.equal((await app.inject({ method: 'PUT', url: '/admin/flags', payload: { key: flagKey, enabled: true }, ...boss.auth })).statusCode, 200);
  assert.equal((await app.inject({ method: 'PUT', url: '/admin/flags', payload: { key: flagKey, enabled: false }, ...boss.auth })).json().flag.enabled, false);
  const flags = (await app.inject({ url: '/admin/flags', ...boss.auth })).json().flags.filter((f: { key: string }) => f.key === flagKey);
  assert.equal(flags.length, 1);

  const log = await app.inject({ url: `/admin/audit?actorId=${boss.user.id}`, ...boss.auth });
  assert.deepEqual(
    log.json().entries.map((e: { action: string }) => e.action).reverse(),
    ['team.added', 'team.updated', 'plan.created', 'plan.updated', 'settings.updated', 'flag.set', 'flag.set'],
  );
});
