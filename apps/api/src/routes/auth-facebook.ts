import { randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { authAccounts, users, type Db } from '@agently/db';
import type { FacebookApp } from '@agently/meta';
import { encryptSecret } from '@agently/shared';
import { endSession, startSession, type CookieSettings } from '../auth/session.ts';

export interface AuthDeps {
  db: Db;
  facebook: Pick<FacebookApp, 'loginUrl' | 'exchangeCode' | 'me'>;
  encryptionKey: string;
  urls: { web: string; api: string };
  cookies: CookieSettings;
}

const STATE_COOKIE = 'agently_fb_state';

/**
 * "Continue with Facebook": signs the user in and keeps their long-lived
 * token (encrypted) so they can list and connect their pages.
 */
export const facebookAuthRoutes: FastifyPluginAsync<AuthDeps> = async (app, deps) => {
  const redirectUri = `${deps.urls.api}/auth/facebook/callback`;

  app.get('/auth/facebook', async (_req, reply) => {
    // The state ties the callback to this browser, so nobody can log a victim into their own account.
    const state = randomBytes(24).toString('base64url');
    reply.setCookie(STATE_COOKIE, state, {
      path: '/auth/facebook',
      httpOnly: true,
      sameSite: 'lax',
      secure: deps.cookies.secure,
      maxAge: 600,
    });
    return reply.redirect(deps.facebook.loginUrl(redirectUri, state));
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/auth/facebook/callback', async (req, reply) => {
    const expected = req.cookies[STATE_COOKIE];
    reply.clearCookie(STATE_COOKIE, { path: '/auth/facebook' });
    const { code, state, error } = req.query;
    if (error || !code) return reply.redirect(`${deps.urls.web}/?error=facebook_cancelled`);
    if (!expected || !state || !safeEqual(state, expected)) return reply.redirect(`${deps.urls.web}/?error=facebook_state`);

    let token;
    let profile;
    try {
      token = await deps.facebook.exchangeCode(code, redirectUri);
      profile = await deps.facebook.me(token.accessToken);
    } catch (err) {
      req.log.warn({ err }, 'Facebook login failed');
      return reply.redirect(`${deps.urls.web}/?error=facebook_failed`);
    }

    const userId = await upsertFacebookUser(deps.db, {
      facebookId: profile.id,
      name: profile.name,
      email: profile.email,
      tokenEncrypted: encryptSecret(token.accessToken, deps.encryptionKey),
      tokenExpiresAt: token.expiresAt,
    });
    await startSession(deps.db, reply, userId, deps.cookies);
    return reply.redirect(`${deps.urls.web}/`);
  });

  app.post('/auth/logout', async (req, reply) => {
    await endSession(deps.db, req, reply, deps.cookies);
    return reply.code(204).send();
  });
};

async function upsertFacebookUser(
  db: Db,
  p: { facebookId: string; name: string; email?: string; tokenEncrypted: string; tokenExpiresAt?: Date },
): Promise<string> {
  return db.transaction(async (tx) => {
    const account = await tx.query.authAccounts.findFirst({
      where: and(eq(authAccounts.provider, 'facebook'), eq(authAccounts.providerAccountId, p.facebookId)),
    });
    if (account) {
      await tx
        .update(authAccounts)
        .set({ accessTokenEncrypted: p.tokenEncrypted, tokenExpiresAt: p.tokenExpiresAt ?? null })
        .where(eq(authAccounts.id, account.id));
      return account.userId;
    }
    // Accounts are never merged by email: that would let anyone who controls an
    // email on one provider take over the account. If the email is taken, leave it off.
    const taken = p.email ? await tx.query.users.findFirst({ where: eq(users.email, p.email) }) : undefined;
    const [user] = await tx
      .insert(users)
      .values({ name: p.name, email: taken ? null : p.email })
      .returning({ id: users.id });
    const userId = user!.id;
    await tx.insert(authAccounts).values({
      userId,
      provider: 'facebook',
      providerAccountId: p.facebookId,
      accessTokenEncrypted: p.tokenEncrypted,
      tokenExpiresAt: p.tokenExpiresAt,
    });
    return userId;
  });
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
