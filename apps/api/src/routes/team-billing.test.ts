/** Team invites and roles, plan limits, and the billing page against a real database. Needs DATABASE_URL. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  activities,
  authAccounts,
  channels,
  conversations,
  createDb,
  creditGrants,
  customers,
  invitations,
  memberships,
  plans,
  sessions,
  usageRecords,
  users,
  workspaces,
  type Db,
} from '@agently/db';
import { encryptSecret } from '@agently/shared';
import { buildServer } from '../server.ts';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL not set';
const WEB = 'https://app.agently.test';
const key = randomBytes(32).toString('base64');
let db: Db;
let close: () => Promise<void>;
let fbPages: { id: string; name: string; accessToken: string; tasks: string[] }[] = [];

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
    facebook: { pages: async () => fbPages, subscribePage: async () => {}, unsubscribePage: async () => {} } as never,
    graph: {} as never,
    encryptionKey: key,
    urls: { web: WEB, api: 'https://api.agently.test' },
    cookies: { secure: true },
    enqueueKnowledge: async () => {},
  });
}

async function plan(limits: Partial<{ pages: number; staffSeats: number; aiCreditsPerMonth: number }> = {}) {
  const [p] = await db
    .insert(plans)
    .values({
      key: `test-${randomBytes(4).toString('hex')}`,
      name: 'Growth',
      priceBdt: '2490',
      priceUsd: '25',
      limits: { pages: 3, agents: 3, aiCreditsPerMonth: 8000, knowledgeBaseMb: 500, staffSeats: 3, ...limits },
    })
    .returning();
  return p!;
}

async function person(name: string) {
  const [user] = await db.insert(users).values({ name }).returning();
  const token = randomBytes(16).toString('hex');
  await db.insert(sessions).values({ userId: user!.id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 864e5) });
  return { user: user!, auth: { cookies: { agently_session: token }, headers: { origin: WEB } } };
}

// 'trial', so the monthly credit job (run by other tests on the same database) leaves these shops alone.
async function shop(planId?: string) {
  const [ws] = await db.insert(workspaces).values({ name: 'Rahim Fashion', status: 'trial', trialEndsAt: new Date(Date.now() + 7 * 864e5), planId }).returning();
  const owner = await person('Rahim');
  await db.insert(memberships).values({ workspaceId: ws!.id, userId: owner.user.id, role: 'owner' });
  return { ws: ws!, owner };
}

test('team: invite with a link, accept, seats counted, link works once', { skip }, async () => {
  const app = server();
  const p = await plan({ staffSeats: 3 });
  const { ws, owner } = await shop(p.id);
  const base = `/api/workspaces/${ws.id}`;

  const inv = await app.inject({ method: 'POST', url: `${base}/invites`, payload: { role: 'agent', email: 'Karim@Example.com' }, ...owner.auth });
  assert.equal(inv.statusCode, 201);
  const link: string = inv.json().url;
  assert.match(link, new RegExp(`^${WEB}/invite/[A-Za-z0-9_-]+$`));
  const token = link.split('/').at(-1)!;
  assert.equal(inv.json().invite.email, 'karim@example.com');
  // Only the hash is stored.
  const [stored] = await db.select().from(invitations).where(eq(invitations.id, inv.json().invite.id));
  assert.notEqual(stored!.tokenHash, token);

  let list = await app.inject({ url: `${base}/members`, ...owner.auth });
  assert.deepEqual(list.json().seats, { used: 2, limit: 3 });
  assert.equal(list.json().invites.length, 1);

  const karim = await person('Karim');
  const preview = await app.inject({ url: `/api/invites/${token}`, ...karim.auth });
  assert.equal(preview.statusCode, 200);
  assert.deepEqual(
    [preview.json().invite.workspace.name, preview.json().invite.role, preview.json().invite.invitedBy, preview.json().invite.state],
    ['Rahim Fashion', 'agent', 'Rahim', 'pending'],
  );

  const accepted = await app.inject({ method: 'POST', url: `/api/invites/${token}/accept`, ...karim.auth });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.json().workspace.id, ws.id);
  const me = await app.inject({ url: '/api/me', ...karim.auth });
  assert.deepEqual(me.json().workspaces.map((w: { id: string; role: string }) => [w.id, w.role]), [[ws.id, 'agent']]);

  list = await app.inject({ url: `${base}/members`, ...karim.auth });
  assert.deepEqual(list.json().seats, { used: 2, limit: 3 });
  assert.deepEqual(list.json().members.map((m: { name: string; role: string }) => [m.name, m.role]), [['Rahim', 'owner'], ['Karim', 'agent']]);

  const stranger = await person('Stranger');
  const again = await app.inject({ method: 'POST', url: `/api/invites/${token}/accept`, ...stranger.auth });
  assert.equal(again.statusCode, 410);
  assert.equal((await app.inject({ method: 'POST', url: `/api/invites/not-a-real-token-at-all-xx/accept`, ...stranger.auth })).statusCode, 404);
  // Staff can't invite.
  assert.equal((await app.inject({ method: 'POST', url: `${base}/invites`, payload: {}, ...karim.auth })).statusCode, 403);
});

test('team: seat limit, revoke, expiry; only the owner invites admins', { skip }, async () => {
  const app = server();
  const p = await plan({ staffSeats: 2 });
  const { ws, owner } = await shop(p.id);
  const base = `/api/workspaces/${ws.id}`;

  const first = await app.inject({ method: 'POST', url: `${base}/invites`, payload: { role: 'admin' }, ...owner.auth });
  assert.equal(first.statusCode, 201);
  const full = await app.inject({ method: 'POST', url: `${base}/invites`, payload: {}, ...owner.auth });
  assert.equal(full.statusCode, 402);
  assert.match(full.json().error, /2 staff seats/);

  // Cancelling an invite frees its seat, and the link stops working.
  assert.equal((await app.inject({ method: 'DELETE', url: `${base}/invites/${first.json().invite.id}`, ...owner.auth })).statusCode, 204);
  const someone = await person('Someone');
  const revoked = await app.inject({ method: 'POST', url: `/api/invites/${first.json().url.split('/').at(-1)}/accept`, ...someone.auth });
  assert.equal(revoked.statusCode, 410);
  assert.match(revoked.json().error, /cancelled/);

  const second = await app.inject({ method: 'POST', url: `${base}/invites`, payload: {}, ...owner.auth });
  assert.equal(second.statusCode, 201);
  await db.update(invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.id, second.json().invite.id));
  const expired = await app.inject({ method: 'POST', url: `/api/invites/${second.json().url.split('/').at(-1)}/accept`, ...someone.auth });
  assert.equal(expired.statusCode, 410);
  assert.match(expired.json().error, /expired/);

  // An admin may invite agents but not admins.
  const admin = await person('Admin');
  await db.insert(memberships).values({ workspaceId: ws.id, userId: admin.user.id, role: 'admin' });
  assert.equal((await app.inject({ method: 'POST', url: `${base}/invites`, payload: { role: 'admin' }, ...admin.auth })).statusCode, 403);

  // Trial-sized plans have one seat: the owner.
  const solo = await shop((await plan({ staffSeats: 1 })).id);
  assert.equal((await app.inject({ method: 'POST', url: `/api/workspaces/${solo.ws.id}/invites`, payload: {}, ...solo.owner.auth })).statusCode, 402);
});

test('team: change role, remove, leave, transfer ownership', { skip }, async () => {
  const app = server();
  const { ws, owner } = await shop((await plan({ staffSeats: 5 })).id);
  const base = `/api/workspaces/${ws.id}`;
  const admin = await person('Admin');
  const agent = await person('Agent');
  const agent2 = await person('Agent Two');
  await db.insert(memberships).values([
    { workspaceId: ws.id, userId: admin.user.id, role: 'admin' },
    { workspaceId: ws.id, userId: agent.user.id, role: 'agent' },
    { workspaceId: ws.id, userId: agent2.user.id, role: 'agent' },
  ]);
  const [channel] = await db.insert(channels).values({ workspaceId: ws.id, type: 'facebook_page', externalId: `p-${randomBytes(4).toString('hex')}`, name: 'Page' }).returning();
  const [customer] = await db.insert(customers).values({ workspaceId: ws.id, name: 'C' }).returning();
  const [conv] = await db.insert(conversations).values({ workspaceId: ws.id, channelId: channel!.id, customerId: customer!.id, assignedUserId: agent.user.id }).returning();

  // Roles: owner only, and never the owner's own role.
  assert.equal((await app.inject({ method: 'PATCH', url: `${base}/members/${agent.user.id}`, payload: { role: 'admin' }, ...admin.auth })).statusCode, 403);
  assert.equal((await app.inject({ method: 'PATCH', url: `${base}/members/${owner.user.id}`, payload: { role: 'agent' }, ...owner.auth })).statusCode, 409);
  assert.equal((await app.inject({ method: 'PATCH', url: `${base}/members/${agent2.user.id}`, payload: { role: 'admin' }, ...owner.auth })).statusCode, 200);
  assert.equal((await app.inject({ method: 'PATCH', url: `${base}/members/${agent2.user.id}`, payload: { role: 'owner' }, ...owner.auth })).statusCode, 400);

  // An admin removes an agent, whose chats go back to the queue; but not another admin, or the owner.
  assert.equal((await app.inject({ method: 'DELETE', url: `${base}/members/${agent.user.id}`, ...admin.auth })).statusCode, 204);
  const [after] = await db.select().from(conversations).where(eq(conversations.id, conv!.id));
  assert.equal(after!.assignedUserId, null);
  assert.equal((await app.inject({ url: `${base}/members`, ...agent.auth })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: `${base}/members/${agent2.user.id}`, ...admin.auth })).statusCode, 403);
  assert.equal((await app.inject({ method: 'DELETE', url: `${base}/members/${owner.user.id}`, ...admin.auth })).statusCode, 409);

  // Anyone but the owner can leave.
  assert.equal((await app.inject({ method: 'DELETE', url: `${base}/members/${owner.user.id}`, ...owner.auth })).statusCode, 409);
  assert.equal((await app.inject({ method: 'DELETE', url: `${base}/members/${agent2.user.id}`, ...agent2.auth })).statusCode, 204);

  // Transfer: the admin becomes the owner, the old owner an admin.
  assert.equal((await app.inject({ method: 'POST', url: `${base}/transfer-ownership`, payload: { userId: admin.user.id }, ...admin.auth })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: `${base}/transfer-ownership`, payload: { userId: admin.user.id }, ...owner.auth })).statusCode, 204);
  const roles = await db.select().from(memberships).where(eq(memberships.workspaceId, ws.id));
  assert.deepEqual(
    Object.fromEntries(roles.map((r) => [r.userId, r.role])),
    { [owner.user.id]: 'admin', [admin.user.id]: 'owner' },
  );
  const feed = await db.select({ type: activities.type }).from(activities).where(eq(activities.workspaceId, ws.id));
  assert.deepEqual(feed.map((f) => f.type).sort(), ['team.left', 'team.ownership_transferred', 'team.removed']);
});

test("plan limits: a new Facebook page needs room in the plan; reconnecting doesn't", { skip }, async () => {
  const app = server();
  const { ws, owner } = await shop((await plan({ pages: 1 })).id);
  await db.insert(authAccounts).values({ userId: owner.user.id, provider: 'facebook', providerAccountId: `fb-${randomBytes(4).toString('hex')}`, accessTokenEncrypted: encryptSecret('user-token', key) });
  const ids = [`pg-${randomBytes(4).toString('hex')}`, `pg-${randomBytes(4).toString('hex')}`];
  fbPages = ids.map((id, i) => ({ id, name: `Page ${i}`, accessToken: `t${i}`, tasks: ['MESSAGING'] }));
  const connect = (id: string) => app.inject({ method: 'POST', url: `/api/workspaces/${ws.id}/facebook/pages/${id}/connect`, ...owner.auth });

  assert.equal((await connect(ids[0]!)).statusCode, 200);
  const second = await connect(ids[1]!);
  assert.equal(second.statusCode, 402);
  assert.match(second.json().error, /1 Facebook page\./);
  assert.equal((await connect(ids[0]!)).statusCode, 200);
});

test('billing: plan, credits with warnings, usage against limits, daily chart', { skip }, async () => {
  const app = server();
  const p = await plan({ aiCreditsPerMonth: 100, staffSeats: 3, pages: 2 });
  const { ws, owner } = await shop(p.id);
  const monthEnd = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1));
  await db.insert(creditGrants).values({ workspaceId: ws.id, reason: 'plan', credits: 100, expiresAt: monthEnd });
  const today = new Date().toISOString().slice(0, 10);
  await db.insert(usageRecords).values({ workspaceId: ws.id, day: today, model: 'm', aiReplies: 85 });

  const res = await app.inject({ url: `/api/workspaces/${ws.id}/billing`, ...owner.auth });
  assert.equal(res.statusCode, 200);
  const b = res.json();
  assert.equal(b.plan.name, 'Growth');
  assert.equal(b.currency, 'BDT');
  assert.deepEqual([b.credits.granted, b.credits.used, b.credits.remaining, b.credits.percentUsed, b.credits.warning], [100, 85, 15, 85, 'low']);
  assert.deepEqual(b.usage.staffSeats, { used: 1, limit: 3 });
  assert.deepEqual(b.usage.pages, { used: 0, limit: 2 });
  assert.equal(b.paymentsAvailable, false);
  assert.ok(b.plans.some((x: { key: string; current: boolean }) => x.key === p.key && x.current));

  const usage = await app.inject({ url: `/api/workspaces/${ws.id}/usage?days=7`, ...owner.auth });
  const days = usage.json().days;
  assert.equal(days.length, 7);
  assert.deepEqual(days.at(-1), { day: today, aiReplies: 85 });
  assert.equal(days[0].aiReplies, 0);

  const staff = await person('Staff');
  await db.insert(memberships).values({ workspaceId: ws.id, userId: staff.user.id, role: 'agent' });
  assert.equal((await app.inject({ url: `/api/workspaces/${ws.id}/billing`, ...staff.auth })).statusCode, 403);
});
