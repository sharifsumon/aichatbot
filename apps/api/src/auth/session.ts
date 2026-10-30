import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { memberships, sessions, users, type Db } from '@agently/db';

export const SESSION_COOKIE = 'agently_session';
const SESSION_DAYS = 30;

export interface CookieSettings {
  secure: boolean;
  domain?: string;
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export async function startSession(db: Db, reply: FastifyReply, userId: string, cookies: CookieSettings): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 864e5);
  await db.insert(sessions).values({ tokenHash: hash(token), userId, expiresAt });
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: cookies.secure,
    domain: cookies.domain,
    expires: expiresAt,
  });
}

export async function endSession(db: Db, request: FastifyRequest, reply: FastifyReply, cookies: CookieSettings): Promise<void> {
  const token = request.cookies[SESSION_COOKIE];
  if (token) await db.delete(sessions).where(eq(sessions.tokenHash, hash(token)));
  reply.clearCookie(SESSION_COOKIE, { path: '/', domain: cookies.domain });
}

export async function sessionUser(db: Db, request: FastifyRequest) {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return undefined;
  const [row] = await db
    .select({ id: users.id, name: users.name, email: users.email, locale: users.locale })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hash(token)), gt(sessions.expiresAt, new Date())));
  return row;
}

export type SessionUser = NonNullable<Awaited<ReturnType<typeof sessionUser>>>;
export type Role = 'owner' | 'admin' | 'agent';

/** The user's role in a workspace, or undefined when they are not a member. */
export async function roleIn(db: Db, userId: string, workspaceId: string): Promise<Role | undefined> {
  const [m] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.workspaceId, workspaceId)));
  return m?.role;
}
