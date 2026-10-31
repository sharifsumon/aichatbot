import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { platformSessions, platformUsers, type Db } from '@agently/db';
import type { CookieSettings } from '../auth/session.ts';

export const ADMIN_COOKIE = 'agently_admin';
/** Between the password and the TOTP code. */
const PENDING_MINUTES = 10;
/** A working day; admins sign in again each morning. */
const SESSION_HOURS = 12;

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export type PlatformRole = 'super_admin' | 'support' | 'finance';
export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: PlatformRole;
  sessionId: string;
  verified: boolean;
}

function setCookie(reply: FastifyReply, token: string, expires: Date, cookies: CookieSettings) {
  reply.setCookie(ADMIN_COOKIE, token, {
    path: '/admin',
    httpOnly: true,
    // The admin app never needs this cookie on a link from another site.
    sameSite: 'strict',
    secure: cookies.secure,
    domain: cookies.domain,
    expires,
  });
}

/** After a correct password: a short session that can only finish two-factor sign-in. */
export async function startPendingSession(db: Db, req: FastifyRequest, reply: FastifyReply, userId: string, cookies: CookieSettings) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + PENDING_MINUTES * 60_000);
  await db.insert(platformSessions).values({ platformUserId: userId, tokenHash: hash(token), verified: false, expiresAt, ip: req.ip });
  setCookie(reply, token, expiresAt, cookies);
}

/** After a correct TOTP code: replaces the pending session with a new token, so it can't be fixed in advance. */
export async function verifySession(db: Db, req: FastifyRequest, reply: FastifyReply, sessionId: string, userId: string, cookies: CookieSettings) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600_000);
  await db.transaction(async (tx) => {
    await tx.delete(platformSessions).where(eq(platformSessions.id, sessionId));
    await tx.insert(platformSessions).values({ platformUserId: userId, tokenHash: hash(token), verified: true, expiresAt, ip: req.ip });
  });
  setCookie(reply, token, expiresAt, cookies);
}

export async function endAdminSession(db: Db, req: FastifyRequest, reply: FastifyReply, cookies: CookieSettings) {
  const token = req.cookies[ADMIN_COOKIE];
  if (token) await db.delete(platformSessions).where(eq(platformSessions.tokenHash, hash(token)));
  reply.clearCookie(ADMIN_COOKIE, { path: '/admin', domain: cookies.domain });
}

/** The signed-in admin, verified or pending. Disabled accounts have no session. */
export async function adminSession(db: Db, req: FastifyRequest): Promise<AdminUser | undefined> {
  const token = req.cookies[ADMIN_COOKIE];
  if (!token) return undefined;
  const [row] = await db
    .select({
      id: platformUsers.id,
      name: platformUsers.name,
      email: platformUsers.email,
      role: platformUsers.role,
      sessionId: platformSessions.id,
      verified: platformSessions.verified,
    })
    .from(platformSessions)
    .innerJoin(platformUsers, eq(platformUsers.id, platformSessions.platformUserId))
    .where(and(eq(platformSessions.tokenHash, hash(token)), gt(platformSessions.expiresAt, new Date()), isNull(platformUsers.disabledAt)));
  return row;
}
