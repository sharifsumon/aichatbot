import { eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { auditLogs, platformSessions, platformUsers, type Db } from '@agently/db';
import { decryptSecret, encryptSecret, hashPassword, newTotpSecret, passwordProblem, totpUri, verifyPassword, verifyTotp } from '@agently/shared';
import type { CookieSettings } from '../auth/session.ts';
import { parseBody } from '../routes/validate.ts';
import { adminSession, endAdminSession, startPendingSession, verifySession } from './session.ts';

export interface AdminAuthDeps {
  db: Db;
  encryptionKey: string;
  cookies: CookieSettings;
}

const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;
// Compared against when the email is unknown, so timing doesn't reveal which emails exist.
const DUMMY_HASH = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const loginBody = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(200) });
const codeBody = z.object({ code: z.string().trim().min(6).max(8) });
const passwordBody = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string() });

/**
 * Admin sign-in: email and password, then a code from an authenticator app.
 * On the first sign-in the response carries a new TOTP secret to add to the
 * app; the first correct code confirms it.
 */
export const adminAuthRoutes: FastifyPluginAsync<AdminAuthDeps> = async (app, deps) => {
  const { db } = deps;

  app.post('/auth/login', async (req, reply) => {
    const body = await parseBody(loginBody, req.body, reply);
    if (!body) return reply;
    const user = await db.query.platformUsers.findFirst({ where: eq(platformUsers.email, body.email) });
    const ok = await verifyPassword(body.password, user?.passwordHash ?? DUMMY_HASH);
    const wrong = { error: 'Wrong email or password' };

    if (!user || user.disabledAt) return reply.code(401).send(wrong);
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      return reply.code(429).send({ error: `Too many failed attempts. Try again after ${user.lockedUntil.toISOString()}.` });
    }
    if (!ok) {
      await recordFailure(db, user.id, user.failedLogins);
      return reply.code(401).send(wrong);
    }

    await startPendingSession(db, req, reply, user.id, deps.cookies);
    if (user.totpConfirmedAt && user.totpSecretEncrypted) return { next: 'totp' };

    // First sign-in, or 2FA was reset: a fresh secret for the authenticator app.
    const secret = newTotpSecret();
    await db.update(platformUsers).set({ totpSecretEncrypted: encryptSecret(secret, deps.encryptionKey), totpConfirmedAt: null, lastTotpStep: null }).where(eq(platformUsers.id, user.id));
    return { next: 'totp_setup', secret, otpauthUrl: totpUri(secret, user.email) };
  });

  app.post('/auth/totp', async (req, reply) => {
    const session = await adminSession(db, req);
    if (!session || session.verified) return reply.code(401).send({ error: 'Sign in with your password first' });
    const body = await parseBody(codeBody, req.body, reply);
    if (!body) return reply;
    const user = (await db.query.platformUsers.findFirst({ where: eq(platformUsers.id, session.id) }))!;
    if (user.lockedUntil && user.lockedUntil > new Date()) return reply.code(429).send({ error: 'Too many failed attempts. Try again later.' });
    if (!user.totpSecretEncrypted) return reply.code(401).send({ error: 'Sign in with your password first' });

    const step = verifyTotp(decryptSecret(user.totpSecretEncrypted, deps.encryptionKey), body.code, { lastUsedStep: user.lastTotpStep });
    if (step === undefined) {
      const locked = await recordFailure(db, user.id, user.failedLogins);
      // A locked account loses its half-finished sign-in too.
      if (locked) await db.delete(platformSessions).where(eq(platformSessions.id, session.sessionId));
      return reply.code(401).send({ error: 'That code is not right. Use the current code from your authenticator app.' });
    }

    const firstTime = !user.totpConfirmedAt;
    await db
      .update(platformUsers)
      .set({ lastTotpStep: step, failedLogins: 0, lockedUntil: null, lastLoginAt: new Date(), ...(firstTime ? { totpConfirmedAt: new Date() } : {}) })
      .where(eq(platformUsers.id, user.id));
    await verifySession(db, req, reply, session.sessionId, user.id, deps.cookies);
    await db.insert(auditLogs).values({ platformUserId: user.id, action: firstTime ? 'auth.2fa_enrolled' : 'auth.signed_in', ip: req.ip });
    return { admin: { id: user.id, name: user.name, email: user.email, role: user.role } };
  });

  app.post('/auth/logout', async (req, reply) => {
    await endAdminSession(db, req, reply, deps.cookies);
    return reply.code(204).send();
  });

  app.get('/auth/me', async (req, reply) => {
    const session = await adminSession(db, req);
    if (!session?.verified) return reply.code(401).send({ error: 'Not signed in' });
    const { sessionId: _s, verified: _v, ...admin } = session;
    return { admin };
  });

  /** Change your own password. Signs out every other session. */
  app.post('/auth/password', async (req, reply) => {
    const session = await adminSession(db, req);
    if (!session?.verified) return reply.code(401).send({ error: 'Not signed in' });
    const body = await parseBody(passwordBody, req.body, reply);
    if (!body) return reply;
    const problem = passwordProblem(body.newPassword);
    if (problem) return reply.code(400).send({ error: problem });
    const user = (await db.query.platformUsers.findFirst({ where: eq(platformUsers.id, session.id) }))!;
    if (!(await verifyPassword(body.currentPassword, user.passwordHash))) return reply.code(401).send({ error: 'Your current password is not right' });
    await db.transaction(async (tx) => {
      await tx.update(platformUsers).set({ passwordHash: await hashPassword(body.newPassword) }).where(eq(platformUsers.id, user.id));
      await tx.delete(platformSessions).where(sql`${platformSessions.platformUserId} = ${user.id} and ${platformSessions.id} <> ${session.sessionId}`);
      await tx.insert(auditLogs).values({ platformUserId: user.id, action: 'auth.password_changed', ip: req.ip });
    });
    return reply.code(204).send();
  });
};

/** Counts a failed password or code; locks the account for a while after too many. Returns whether it locked. */
async function recordFailure(db: Db, userId: string, current: number): Promise<boolean> {
  const failures = current + 1;
  const lock = failures >= MAX_FAILURES;
  await db
    .update(platformUsers)
    .set({ failedLogins: lock ? 0 : failures, lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null })
    .where(eq(platformUsers.id, userId));
  return lock;
}
