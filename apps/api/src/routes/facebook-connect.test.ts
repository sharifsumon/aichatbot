/** The Facebook sign-in → workspace → page connect flow, against a real database. Needs DATABASE_URL. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { authAccounts, channels, createDb, creditGrants, plans, users, type Db } from '@agently/db';
import { GraphApiError, type FacebookPage } from '@agently/meta';
import { decryptSecret } from '@agently/shared';
import { buildServer, type ServerDeps } from '../server.ts';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL not set';
const key = randomBytes(32).toString('base64');
const WEB = 'https://app.agently.test';
let db: Db;
let close: () => Promise<void>;

before(async () => {
  if (skip) return;
  ({ db, close } = createDb(url!, { max: 4 }));
  await db
    .insert(plans)
    .values({ key: 'trial', name: 'Free trial', priceBdt: '0', priceUsd: '0', trialDays: 14, limits: { pages: 1, agents: 1, aiCreditsPerMonth: 300, knowledgeBaseMb: 20, staffSeats: 1 } })
    .onConflictDoNothing();
});
after(async () => {
  if (!skip) await close();
});

function setup(fbUser: { id: string; name: string; email?: string }, pages: FacebookPage[]) {
  const calls: string[] = [];
  const facebook: ServerDeps['facebook'] = {
    loginUrl: (redirect, state) => `https://facebook.test/dialog?redirect_uri=${encodeURIComponent(redirect)}&state=${state}`,
    exchangeCode: async (code) => {
      if (code !== 'good-code') throw new GraphApiError('bad code', 400);
      return { accessToken: `user-token-${fbUser.id}` };
    },
    me: async () => fbUser,
    pages: async (token) => {
      if (token !== `user-token-${fbUser.id}`) throw new GraphApiError('expired', 400, 190);
      return pages;
    },
    subscribePage: async (pageId) => void calls.push(`subscribe ${pageId}`),
    unsubscribePage: async (pageId) => void calls.push(`unsubscribe ${pageId}`),
    parseSignedRequest: (s) => (s.startsWith('valid:') ? { user_id: s.slice(6) } : null),
  };
  const app = buildServer({
    db,
    redis: { ping: async () => 'PONG' },
    inbound: { add: async () => {} },
    meta: { appSecret: 's', verifyToken: 'v' },
    facebook,
    encryptionKey: key,
    urls: { web: WEB, api: 'https://api.agently.test' },
    cookies: { secure: true },
  });
  return { app, calls };
}

async function signIn(app: ReturnType<typeof setup>['app']): Promise<string> {
  const start = await app.inject({ url: '/auth/facebook' });
  assert.equal(start.statusCode, 302);
  const state = new URL(start.headers.location as string).searchParams.get('state')!;
  const stateCookie = start.cookies.find((c) => c.name === 'agently_fb_state')!;
  const cb = await app.inject({
    url: `/auth/facebook/callback?code=good-code&state=${state}`,
    cookies: { agently_fb_state: stateCookie.value },
  });
  assert.equal(cb.statusCode, 302);
  assert.equal(cb.headers.location, `${WEB}/`);
  const session = cb.cookies.find((c) => c.name === 'agently_session');
  assert.ok(session?.httpOnly && session.secure);
  return session.value;
}

const page = (id: string, tasks = ['MESSAGING', 'MODERATE']): FacebookPage => ({ id, name: `Page ${id}`, accessToken: `page-token-${id}`, tasks });
const fbId = () => `fb-${randomBytes(6).toString('hex')}`;

test('sign in, create a shop, connect a page, disconnect it', { skip }, async () => {
  const pageId = `p-${randomBytes(4).toString('hex')}`;
  const { app, calls } = setup({ id: fbId(), name: 'Sharif' }, [page(pageId), page(`${pageId}-ro`, ['ANALYZE'])]);
  const session = await signIn(app);
  const auth = { cookies: { agently_session: session }, headers: { origin: WEB } };

  const created = await app.inject({ method: 'POST', url: '/api/workspaces', payload: { name: 'Rahim Fashion' }, ...auth });
  assert.equal(created.statusCode, 201);
  const wsId = created.json().workspace.id;
  const [grant] = await db.select().from(creditGrants).where(eq(creditGrants.workspaceId, wsId));
  assert.equal(grant!.credits, 300);

  const me = await app.inject({ url: '/api/me', ...auth });
  assert.deepEqual(me.json().workspaces.map((w: { id: string; role: string }) => [w.id, w.role]), [[wsId, 'owner']]);

  const list = await app.inject({ url: `/api/workspaces/${wsId}/facebook/pages`, ...auth });
  assert.deepEqual(
    list.json().pages.map((p: { id: string; canMessage: boolean; connected: string | null }) => [p.id, p.canMessage, p.connected]),
    [
      [pageId, true, null],
      [`${pageId}-ro`, false, null],
    ],
  );

  const ro = await app.inject({ method: 'POST', url: `/api/workspaces/${wsId}/facebook/pages/${pageId}-ro/connect`, ...auth });
  assert.equal(ro.statusCode, 403);

  const connect = await app.inject({ method: 'POST', url: `/api/workspaces/${wsId}/facebook/pages/${pageId}/connect`, ...auth });
  assert.equal(connect.statusCode, 200);
  assert.deepEqual(calls, [`subscribe ${pageId}`]);
  const [channel] = await db.select().from(channels).where(eq(channels.externalId, pageId));
  assert.equal(channel!.workspaceId, wsId);
  assert.ok(channel!.agentId);
  assert.equal(decryptSecret(channel!.accessTokenEncrypted!, key), `page-token-${pageId}`);

  const relist = await app.inject({ url: `/api/workspaces/${wsId}/facebook/pages`, ...auth });
  assert.equal(relist.json().pages[0].connected, 'this_workspace');

  const off = await app.inject({ method: 'POST', url: `/api/workspaces/${wsId}/channels/${channel!.id}/disconnect`, ...auth });
  assert.equal(off.statusCode, 204);
  assert.deepEqual(calls, [`subscribe ${pageId}`, `unsubscribe ${pageId}`]);
  const [after] = await db.select().from(channels).where(eq(channels.id, channel!.id));
  assert.equal(after!.status, 'disconnected');
  assert.equal(after!.accessTokenEncrypted, null);
});

test('one page belongs to one shop; strangers see nothing', { skip }, async () => {
  const pageId = `p-${randomBytes(4).toString('hex')}`;
  const a = setup({ id: fbId(), name: 'A' }, [page(pageId)]);
  const b = setup({ id: fbId(), name: 'B' }, [page(pageId)]);
  const sa = { cookies: { agently_session: await signIn(a.app) }, headers: { origin: WEB } };
  const sb = { cookies: { agently_session: await signIn(b.app) }, headers: { origin: WEB } };
  const wsA = (await a.app.inject({ method: 'POST', url: '/api/workspaces', payload: { name: 'Shop A' }, ...sa })).json().workspace.id;
  const wsB = (await b.app.inject({ method: 'POST', url: '/api/workspaces', payload: { name: 'Shop B' }, ...sb })).json().workspace.id;

  assert.equal((await a.app.inject({ method: 'POST', url: `/api/workspaces/${wsA}/facebook/pages/${pageId}/connect`, ...sa })).statusCode, 200);
  const taken = await b.app.inject({ method: 'POST', url: `/api/workspaces/${wsB}/facebook/pages/${pageId}/connect`, ...sb });
  assert.equal(taken.statusCode, 409);

  // B cannot see or act on A's workspace.
  assert.equal((await b.app.inject({ url: `/api/workspaces/${wsA}/facebook/pages`, ...sb })).statusCode, 404);
  const [channel] = await db.select().from(channels).where(eq(channels.externalId, pageId));
  assert.equal((await b.app.inject({ method: 'POST', url: `/api/workspaces/${wsB}/channels/${channel!.id}/disconnect`, ...sb })).statusCode, 404);
  assert.equal((await b.app.inject({ method: 'POST', url: `/api/workspaces/${wsA}/channels/${channel!.id}/disconnect`, ...sb })).statusCode, 404);
});

test('requests without a session, from another origin, or with a forged state are refused', { skip }, async () => {
  const { app } = setup({ id: fbId(), name: 'X' }, []);
  assert.equal((await app.inject({ url: '/api/me' })).statusCode, 401);
  const session = await signIn(app);
  const evil = await app.inject({ method: 'POST', url: '/api/workspaces', payload: { name: 'Evil' }, cookies: { agently_session: session }, headers: { origin: 'https://evil.test' } });
  assert.equal(evil.statusCode, 403);

  const forged = await app.inject({ url: '/auth/facebook/callback?code=good-code&state=abc', cookies: { agently_fb_state: 'xyz' } });
  assert.equal(forged.headers.location, `${WEB}/?error=facebook_state`);
  assert.equal(forged.cookies.find((c) => c.name === 'agently_session'), undefined);

  const preflight = await app.inject({ method: 'OPTIONS', url: '/api/workspaces', headers: { origin: WEB, 'access-control-request-method': 'POST' } });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], WEB);
  assert.equal(preflight.headers['access-control-allow-credentials'], 'true');

  const out = await app.inject({ method: 'POST', url: '/auth/logout', cookies: { agently_session: session } });
  assert.equal(out.statusCode, 204);
  assert.equal((await app.inject({ url: '/api/me', cookies: { agently_session: session } })).statusCode, 401);
});

test('signing in twice reuses the account and refreshes the token', { skip }, async () => {
  const id = fbId();
  const { app } = setup({ id, name: 'Twice' }, []);
  await signIn(app);
  await signIn(app);
  const accounts = await db.select().from(authAccounts).where(eq(authAccounts.providerAccountId, id));
  assert.equal(accounts.length, 1);
});

test('data deletion removes the sign-in and the user, and answers with a status URL', { skip }, async () => {
  const id = fbId();
  const { app } = setup({ id, name: 'Leaving' }, []);
  const session = await signIn(app);
  const [account] = await db.select().from(authAccounts).where(eq(authAccounts.providerAccountId, id));

  const bad = await app.inject({ method: 'POST', url: '/webhooks/meta/data-deletion', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'signed_request=forged' });
  assert.equal(bad.statusCode, 400);

  const res = await app.inject({
    method: 'POST',
    url: '/webhooks/meta/data-deletion',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `signed_request=${encodeURIComponent(`valid:${id}`)}`,
  });
  assert.equal(res.statusCode, 200);
  const { url: statusUrl, confirmation_code } = res.json();
  assert.equal(statusUrl, `https://api.agently.test/webhooks/meta/data-deletion/${confirmation_code}`);
  assert.equal((await db.select().from(users).where(eq(users.id, account!.userId))).length, 0);
  assert.equal((await app.inject({ url: '/api/me', cookies: { agently_session: session } })).statusCode, 401);

  const status = await app.inject({ url: `/webhooks/meta/data-deletion/${confirmation_code}` });
  assert.match(status.json().status, /deleted/);
});

