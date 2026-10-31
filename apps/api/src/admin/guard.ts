import type { FastifyReply, FastifyRequest } from 'fastify';
import { auditLogs, type Db } from '@agently/db';
import type { AdminUser, PlatformRole } from './session.ts';

/** What each platform role may do. Support never sees billing; finance never reads chats. */
export const PERMISSIONS = {
  'tenants.read': ['super_admin', 'support', 'finance'],
  'tenants.manage': ['super_admin', 'support'],
  'conversations': ['super_admin', 'support'],
  'usage.read': ['super_admin', 'support', 'finance'],
  'billing.manage': ['super_admin', 'finance'],
  'audit.read': ['super_admin'],
  'team.manage': ['super_admin'],
  'settings.manage': ['super_admin'],
} satisfies Record<string, PlatformRole[]>;

export type Permission = keyof typeof PERMISSIONS;

declare module 'fastify' {
  interface FastifyRequest {
    admin: AdminUser;
  }
}

export const can = (role: PlatformRole, perm: Permission) => (PERMISSIONS[perm] as PlatformRole[]).includes(role);

export async function requirePerm(req: FastifyRequest, reply: FastifyReply, perm: Permission): Promise<boolean> {
  if (can(req.admin.role, perm)) return true;
  await reply.code(403).send({ error: 'Your role does not allow this' });
  return false;
}

/** Writes one audit log row. Every admin view of tenant data and every change goes through here. */
export async function audit(
  db: Db,
  req: FastifyRequest,
  action: string,
  target: { workspaceId?: string | null; targetType?: string; targetId?: string; data?: Record<string, unknown> } = {},
): Promise<void> {
  await db.insert(auditLogs).values({
    platformUserId: req.admin.id,
    action,
    workspaceId: target.workspaceId ?? null,
    targetType: target.targetType,
    targetId: target.targetId,
    data: target.data ?? {},
    ip: req.ip,
  });
}

/**
 * Masks phone numbers (Latin or Bangla digits) so a chat can be read without
 * exposing contact details; "01712345678" becomes "017•••••678".
 */
export function maskPhones(text: string): string {
  return text.replace(/(?:\+?(?:88|৮৮))?[0০][1১][3-9৩-৯][\d০-৯]{8}/g, (m) => `${m.slice(0, -8)}•••••${m.slice(-3)}`);
}

export function maskAddress(address: string | null): string | null {
  if (!address) return address;
  // Keep the last part (usually the area or city), hide the rest.
  const parts = address.split(/,\s*/);
  return parts.length > 1 ? `••••, ${parts.at(-1)}` : '••••';
}
