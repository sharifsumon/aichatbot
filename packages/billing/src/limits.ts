import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { channels, invitations, memberships, plans, workspaces, type Db, type PlanLimits } from '@agently/db';

/** Used when a workspace has no plan; the same as the free trial. */
export const DEFAULT_LIMITS: PlanLimits = { pages: 1, agents: 1, aiCreditsPerMonth: 300, knowledgeBaseMb: 20, staffSeats: 1, whatsappNumbers: 0, instagramAccounts: 0 };

/** The channel types a plan counts, and what they are called to shop owners. */
export type CountedChannel = 'facebook_page' | 'whatsapp' | 'instagram';

export const CHANNEL_NAMES: Record<CountedChannel, { one: string; many: string }> = {
  facebook_page: { one: 'Facebook page', many: 'Facebook pages' },
  whatsapp: { one: 'WhatsApp number', many: 'WhatsApp numbers' },
  instagram: { one: 'Instagram account', many: 'Instagram accounts' },
};

/** How many channels of a type the plan allows. Plans saved before WhatsApp and Instagram allow none. */
export function channelLimit(limits: PlanLimits, type: CountedChannel): number {
  if (type === 'facebook_page') return limits.pages;
  return (type === 'whatsapp' ? limits.whatsappNumbers : limits.instagramAccounts) ?? 0;
}

export async function planFor(db: Db, workspaceId: string) {
  const [row] = await db
    .select({ plan: plans })
    .from(workspaces)
    .leftJoin(plans, eq(plans.id, workspaces.planId))
    .where(eq(workspaces.id, workspaceId));
  return row?.plan ?? undefined;
}

export async function limitsFor(db: Db, workspaceId: string): Promise<PlanLimits> {
  return (await planFor(db, workspaceId))?.limits ?? DEFAULT_LIMITS;
}

/** Facebook pages connected (or needing a reconnect); disconnected ones don't count. */
export async function pagesInUse(db: Db, workspaceId: string): Promise<number> {
  return channelsInUse(db, workspaceId, 'facebook_page');
}

/** Channels of one type connected (or needing a reconnect); disconnected ones don't count. */
export async function channelsInUse(db: Db, workspaceId: string, type: CountedChannel): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(channels)
    .where(and(eq(channels.workspaceId, workspaceId), eq(channels.type, type), ne(channels.status, 'disconnected')));
  return row?.n ?? 0;
}

/** Members (the owner included) plus invites that can still be accepted. */
export async function seatsInUse(db: Db, workspaceId: string, now = new Date()): Promise<{ members: number; pendingInvites: number }> {
  const [[m], [i]] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(memberships).where(eq(memberships.workspaceId, workspaceId)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(invitations)
      .where(
        and(
          eq(invitations.workspaceId, workspaceId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, now),
        ),
      ),
  ]);
  return { members: m?.n ?? 0, pendingInvites: i?.n ?? 0 };
}
