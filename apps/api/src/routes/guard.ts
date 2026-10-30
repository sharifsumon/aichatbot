import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '@agently/db';
import { roleIn, type Role } from '../auth/session.ts';

export const ALL_ROLES: Role[] = ['owner', 'admin', 'agent'];
export const MANAGERS: Role[] = ['owner', 'admin'];

/**
 * Checks the signed-in user's role in the :workspaceId of the route and
 * replies with an error when it falls short. Non-members get 404 rather than
 * 403, so workspace ids can't be probed. Returns true when the request may go on.
 */
export async function requireRole(
  db: Db,
  req: FastifyRequest<{ Params: { workspaceId: string } }>,
  reply: FastifyReply,
  allowed: Role[],
): Promise<boolean> {
  const role = isUuid(req.params.workspaceId) ? await roleIn(db, req.user.id, req.params.workspaceId) : undefined;
  if (!role) {
    await reply.code(404).send({ error: 'Workspace not found' });
    return false;
  }
  if (!allowed.includes(role)) {
    await reply.code(403).send({ error: 'Only the owner or an admin can do this' });
    return false;
  }
  return true;
}

export function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/** Keyset pagination: "<iso time>|<uuid>" of the last row on the previous page. */
export function parseCursor(cursor: string | undefined): { at: Date; id: string } | undefined {
  if (!cursor) return undefined;
  const [iso, id] = cursor.split('|');
  const at = new Date(iso ?? '');
  return id && isUuid(id) && !Number.isNaN(at.getTime()) ? { at, id } : undefined;
}

export const makeCursor = (at: Date, id: string) => `${at.toISOString()}|${id}`;

export function pageLimit(raw: unknown, max = 100, fallback = 30): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}
