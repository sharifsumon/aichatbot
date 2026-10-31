import { createHash, randomBytes } from 'node:crypto';
import { and, asc, desc, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { limitsFor, seatsInUse } from '@agently/billing';
import { activities, conversations, invitations, memberships, users, workspaces, type Db } from '@agently/db';
import { roleIn } from '../auth/session.ts';
import { ALL_ROLES, MANAGERS, isUuid, requireRole } from './guard.ts';
import { parseBody } from './validate.ts';

export interface TeamDeps {
  db: Db;
  urls: { web: string };
}

export const INVITE_DAYS = 7;

const inviteBody = z
  .object({
    role: z.enum(['admin', 'agent']).default('agent'),
    email: z.string().trim().toLowerCase().email().max(200).nullish(),
  })
  .strict();

const roleBody = z.object({ role: z.enum(['admin', 'agent']) }).strict();

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Team members and invites. Owners manage everyone; admins can invite and
 * remove agents. A seat is a member or an unexpired invite, the owner included.
 */
export const teamRoutes: FastifyPluginAsync<TeamDeps> = async (app, deps) => {
  const { db } = deps;

  app.get<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/members', async (req, reply) => {
    if (!(await requireRole(db, req, reply, ALL_ROLES))) return reply;
    const { workspaceId } = req.params;
    const [members, invites, seats, limits] = await Promise.all([
      db
        .select({ userId: users.id, name: users.name, email: users.email, role: memberships.role, joinedAt: memberships.createdAt })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(memberships.workspaceId, workspaceId))
        .orderBy(asc(memberships.createdAt)),
      db
        .select({ id: invitations.id, role: invitations.role, email: invitations.email, expiresAt: invitations.expiresAt, createdAt: invitations.createdAt })
        .from(invitations)
        .where(pendingIn(workspaceId))
        .orderBy(desc(invitations.createdAt)),
      seatsInUse(db, workspaceId),
      limitsFor(db, workspaceId),
    ]);
    return { members, invites, seats: { used: seats.members + seats.pendingInvites, limit: limits.staffSeats } };
  });

  /** Creates an invite link. The token is in the response only, so share it now. */
  app.post<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/invites', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    const body = await parseBody(inviteBody, req.body, reply);
    if (!body) return reply;
    const { workspaceId } = req.params;
    const myRole = await roleIn(db, req.user.id, workspaceId);
    if (body.role === 'admin' && myRole !== 'owner') return reply.code(403).send({ error: 'Only the owner can invite an admin' });

    const [seats, limits] = await Promise.all([seatsInUse(db, workspaceId), limitsFor(db, workspaceId)]);
    if (seats.members + seats.pendingInvites >= limits.staffSeats) {
      return reply.code(402).send({
        error: `Your plan has ${limits.staffSeats} staff ${limits.staffSeats === 1 ? 'seat' : 'seats'} and they are all taken. Remove someone, cancel an invite, or upgrade.`,
        limit: 'staffSeats',
      });
    }

    const token = randomBytes(24).toString('base64url');
    const [invite] = await db
      .insert(invitations)
      .values({
        workspaceId,
        role: body.role,
        email: body.email ?? null,
        tokenHash: hashToken(token),
        invitedByUserId: req.user.id,
        expiresAt: new Date(Date.now() + INVITE_DAYS * 864e5),
      })
      .returning();
    await db.insert(activities).values({
      workspaceId,
      type: 'team.invited',
      text: `${req.user.name} invited ${body.email ?? 'a new team member'} as ${body.role}`,
      actorUserId: req.user.id,
      data: { inviteId: invite!.id },
    });
    return reply.code(201).send({
      invite: { id: invite!.id, role: invite!.role, email: invite!.email, expiresAt: invite!.expiresAt },
      url: `${deps.urls.web}/invite/${token}`,
    });
  });

  app.delete<{ Params: { workspaceId: string; inviteId: string } }>('/workspaces/:workspaceId/invites/:inviteId', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    if (!isUuid(req.params.inviteId)) return reply.code(404).send({ error: 'Invite not found' });
    const [revoked] = await db
      .update(invitations)
      .set({ revokedAt: new Date() })
      .where(and(eq(invitations.id, req.params.inviteId), pendingIn(req.params.workspaceId)))
      .returning({ id: invitations.id });
    if (!revoked) return reply.code(404).send({ error: 'Invite not found' });
    return reply.code(204).send();
  });

  /** What the invite is for, so the page can say "Join <shop> as <role>". */
  app.get<{ Params: { token: string } }>('/invites/:token', async (req, reply) => {
    const invite = await findInvite(db, req.params.token);
    if (!invite) return reply.code(404).send({ error: 'This invite link is not valid' });
    const state = inviteState(invite);
    const alreadyMember = !!(await roleIn(db, req.user.id, invite.workspaceId));
    return { invite: { workspace: { id: invite.workspaceId, name: invite.workspaceName }, role: invite.role, invitedBy: invite.invitedBy, state, alreadyMember } };
  });

  app.post<{ Params: { token: string } }>('/invites/:token/accept', async (req, reply) => {
    const invite = await findInvite(db, req.params.token);
    if (!invite) return reply.code(404).send({ error: 'This invite link is not valid' });
    const state = inviteState(invite);
    if (state !== 'pending') {
      const why = { accepted: 'has already been used', revoked: 'was cancelled', expired: 'has expired' }[state];
      return reply.code(410).send({ error: `This invite ${why}. Ask the shop for a new one.` });
    }
    const workspace = { id: invite.workspaceId, name: invite.workspaceName };
    if (await roleIn(db, req.user.id, invite.workspaceId)) return { workspace, alreadyMember: true };

    const result = await db.transaction(async (tx) => {
      // Lock the invite so two clicks can't both take a seat.
      const [locked] = await tx
        .update(invitations)
        .set({ acceptedAt: new Date(), acceptedByUserId: req.user.id })
        .where(and(eq(invitations.id, invite.id), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
        .returning({ id: invitations.id });
      if (!locked) return 'gone' as const;
      await tx.insert(memberships).values({ workspaceId: invite.workspaceId, userId: req.user.id, role: invite.role }).onConflictDoNothing();
      await tx.insert(activities).values({
        workspaceId: invite.workspaceId,
        type: 'team.joined',
        text: `${req.user.name} joined the team as ${invite.role}`,
        actorUserId: req.user.id,
        data: { inviteId: invite.id },
      });
      return 'ok' as const;
    });
    if (result === 'gone') return reply.code(410).send({ error: 'This invite has already been used. Ask the shop for a new one.' });
    return { workspace, alreadyMember: false };
  });

  /** Owner only: make someone an admin or an agent. */
  app.patch<{ Params: { workspaceId: string; userId: string } }>('/workspaces/:workspaceId/members/:userId', async (req, reply) => {
    if (!(await requireRole(db, req, reply, ['owner']))) return reply;
    const body = await parseBody(roleBody, req.body, reply);
    if (!body) return reply;
    const target = await memberOf(db, req.params.workspaceId, req.params.userId);
    if (!target) return reply.code(404).send({ error: 'Member not found' });
    if (target.role === 'owner') return reply.code(409).send({ error: 'Transfer ownership to change the owner' });
    await db
      .update(memberships)
      .set({ role: body.role })
      .where(and(eq(memberships.workspaceId, req.params.workspaceId), eq(memberships.userId, target.userId)));
    return { member: { userId: target.userId, role: body.role } };
  });

  /** Remove a member, or leave the shop (your own user id). The owner can't leave without transferring. */
  app.delete<{ Params: { workspaceId: string; userId: string } }>('/workspaces/:workspaceId/members/:userId', async (req, reply) => {
    if (!(await requireRole(db, req, reply, ALL_ROLES))) return reply;
    const { workspaceId } = req.params;
    const target = await memberOf(db, workspaceId, req.params.userId);
    if (!target) return reply.code(404).send({ error: 'Member not found' });
    const myRole = (await roleIn(db, req.user.id, workspaceId))!;
    const self = target.userId === req.user.id;

    if (target.role === 'owner') {
      return reply.code(409).send({ error: self ? 'Transfer ownership before you leave' : 'The owner cannot be removed' });
    }
    if (!self && !(myRole === 'owner' || (myRole === 'admin' && target.role === 'agent'))) {
      return reply.code(403).send({ error: myRole === 'admin' ? 'Only the owner can remove an admin' : 'Only the owner or an admin can do this' });
    }

    await db.transaction(async (tx) => {
      await tx.delete(memberships).where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, target.userId)));
      // Their chats go back to the shared queue.
      await tx
        .update(conversations)
        .set({ assignedUserId: null })
        .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.assignedUserId, target.userId)));
      await tx.insert(activities).values({
        workspaceId,
        type: self ? 'team.left' : 'team.removed',
        text: self ? `${target.name} left the team` : `${target.name} was removed from the team`,
        actorUserId: req.user.id,
        data: { userId: target.userId },
      });
    });
    return reply.code(204).send();
  });

  /** Owner only: hand the shop to another member. The old owner becomes an admin. */
  app.post<{ Params: { workspaceId: string }; Body: { userId?: unknown } }>('/workspaces/:workspaceId/transfer-ownership', async (req, reply) => {
    if (!(await requireRole(db, req, reply, ['owner']))) return reply;
    const userId = typeof req.body?.userId === 'string' ? req.body.userId : '';
    const { workspaceId } = req.params;
    if (userId === req.user.id) return reply.code(400).send({ error: 'You are already the owner' });
    const target = await memberOf(db, workspaceId, userId);
    if (!target) return reply.code(404).send({ error: 'Member not found' });
    await db.transaction(async (tx) => {
      await tx.update(memberships).set({ role: 'owner' }).where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, target.userId)));
      await tx.update(memberships).set({ role: 'admin' }).where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, req.user.id)));
      await tx.insert(activities).values({
        workspaceId,
        type: 'team.ownership_transferred',
        text: `${req.user.name} made ${target.name} the owner`,
        actorUserId: req.user.id,
        data: { userId: target.userId },
      });
    });
    return reply.code(204).send();
  });
};

function pendingIn(workspaceId: string) {
  return and(
    eq(invitations.workspaceId, workspaceId),
    isNull(invitations.acceptedAt),
    isNull(invitations.revokedAt),
    gt(invitations.expiresAt, new Date()),
  );
}

async function memberOf(db: Db, workspaceId: string, userId: string) {
  if (!isUuid(userId)) return undefined;
  const [row] = await db
    .select({ userId: memberships.userId, role: memberships.role, name: users.name })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)));
  return row;
}

async function findInvite(db: Db, token: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return undefined;
  const [row] = await db
    .select({
      id: invitations.id,
      workspaceId: invitations.workspaceId,
      workspaceName: workspaces.name,
      role: invitations.role,
      invitedBy: users.name,
      expiresAt: invitations.expiresAt,
      acceptedAt: invitations.acceptedAt,
      revokedAt: invitations.revokedAt,
    })
    .from(invitations)
    .innerJoin(workspaces, eq(workspaces.id, invitations.workspaceId))
    .leftJoin(users, eq(users.id, invitations.invitedByUserId))
    .where(eq(invitations.tokenHash, hashToken(token)));
  return row;
}

function inviteState(i: { acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date }) {
  if (i.acceptedAt) return 'accepted' as const;
  if (i.revokedAt) return 'revoked' as const;
  if (i.expiresAt <= new Date()) return 'expired' as const;
  return 'pending' as const;
}
