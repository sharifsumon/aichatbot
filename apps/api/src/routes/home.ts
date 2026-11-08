import { and, desc, eq, inArray, lt, ne, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { creditSummary } from '@agently/billing';
import {
  activities,
  agents,
  channels,
  conversations,
  customers,
  knowledgeSources,
  messages,
  orders,
  products,
  workspaces,
  type Db,
} from '@agently/db';
import type { InboxDeps } from './inbox.ts';
import { sendHumanReply } from './send-reply.ts';
import { ALL_ROLES, isUuid, makeCursor, pageLimit, parseCursor, requireRole } from './guard.ts';

/**
 * The dashboard home (what needs the shop today and the setup checklist),
 * the connected pages, the activity feed, and the Comments page.
 */
export const homeRoutes: FastifyPluginAsync<InboxDeps> = async (app, deps) => {
  const { db } = deps;

  app.get<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/home', async (req, reply) => {
    if (!(await requireRole(db, req, reply, ALL_ROLES))) return reply;
    const { workspaceId } = req.params;
    const now = new Date();
    const dayStart = new Date(now);
    dayStart.setUTCHours(0, 0, 0, 0);
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const count = sql<number>`count(*)::int`;

    const [ws, agent, pageRows, chats, orderStats, productCount, knowledgeCount, credits, feed] = await Promise.all([
      db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) }),
      db.query.agents.findFirst({ where: eq(agents.workspaceId, workspaceId), orderBy: agents.createdAt }),
      listChannels(db, workspaceId),
      db
        .select({ mode: conversations.mode, n: count })
        .from(conversations)
        .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.status, 'open')))
        .groupBy(conversations.mode),
      db
        .select({
          today: sql<number>`count(*) filter (where ${orders.createdAt} >= ${dayStart.toISOString()})::int`,
          awaitingPayment: sql<number>`count(*) filter (where ${orders.paymentStatus} = 'pending_verification')::int`,
          toShip: sql<number>`count(*) filter (where ${orders.status} = 'confirmed' and ${orders.checkoutStep} = 'complete')::int`,
          revenueThisMonth: sql<string>`coalesce(sum(${orders.total}) filter (where ${orders.createdAt} >= ${monthStart.toISOString()} and ${orders.status} not in ('cancelled', 'returned')), 0)`,
          ordersThisMonth: sql<number>`count(*) filter (where ${orders.createdAt} >= ${monthStart.toISOString()} and ${orders.status} not in ('cancelled', 'returned'))::int`,
        })
        .from(orders)
        .where(eq(orders.workspaceId, workspaceId)),
      db.select({ n: count }).from(products).where(and(eq(products.workspaceId, workspaceId), ne(products.status, 'archived'))),
      db.select({ n: count }).from(knowledgeSources).where(eq(knowledgeSources.workspaceId, workspaceId)),
      creditSummary(db, workspaceId, now),
      recentActivity(db, workspaceId, 8),
    ]);
    const o = orderStats[0]!;
    const pagesConnected = pageRows.some((c) => c.status === 'connected');

    return {
      shop: { name: ws!.name, status: ws!.status, trialEndsAt: ws!.trialEndsAt, suspendedReason: ws!.suspendedReason, onboardingCompletedAt: ws!.onboardingCompletedAt },
      agent: agent ? { name: agent.name, status: agent.status } : null,
      channels: pageRows,
      stats: {
        needsYou: chats.find((c) => c.mode === 'human')?.n ?? 0,
        aiHandling: chats.find((c) => c.mode === 'ai')?.n ?? 0,
        ordersToday: o.today,
        awaitingPayment: o.awaitingPayment,
        toShip: o.toShip,
        ordersThisMonth: o.ordersThisMonth,
        revenueThisMonth: o.revenueThisMonth,
      },
      // The first-run checklist, in the order a new shop should do it.
      setup: {
        pageConnected: pagesConnected,
        products: productCount[0]?.n ?? 0,
        knowledgeSources: knowledgeCount[0]?.n ?? 0,
        paymentNumbers: !!(ws!.bkashNumber || ws!.nagadNumber),
        agentLive: agent?.status === 'live',
      },
      credits,
      activity: feed,
    };
  });

  app.get<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/channels', async (req, reply) => {
    if (!(await requireRole(db, req, reply, ALL_ROLES))) return reply;
    return { channels: await listChannels(db, req.params.workspaceId) };
  });

  /** The shop's activity feed, newest first. */
  app.get<{ Params: { workspaceId: string }; Querystring: { cursor?: string; limit?: string } }>(
    '/workspaces/:workspaceId/activities',
    async (req, reply) => {
      if (!(await requireRole(db, req, reply, ALL_ROLES))) return reply;
      const limit = pageLimit(req.query.limit, 100, 50);
      const rows = await recentActivity(db, req.params.workspaceId, limit + 1, parseCursor(req.query.cursor));
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return { activities: page, nextCursor: rows.length > limit && last ? makeCursor(last.createdAt, last.id) : null };
    },
  );

  /**
   * Customer comments on the shop's posts, newest first, each with the
   * replies under it. `needs_you`: nobody has answered it yet.
   */
  app.get<{ Params: { workspaceId: string }; Querystring: { filter?: string; cursor?: string; limit?: string } }>(
    '/workspaces/:workspaceId/comments',
    async (req, reply) => {
      if (!(await requireRole(db, req, reply, ALL_ROLES))) return reply;
      const { workspaceId } = req.params;
      const limit = pageLimit(req.query.limit, 100, 30);
      const cursor = parseCursor(req.query.cursor);
      const answered = sql`exists (select 1 from ${messages} r where r.workspace_id = ${workspaceId} and r.direction = 'outbound' and r.delivery <> 'failed' and r.meta->>'replyToMessageId' = ${messages.id}::text)`;
      const filter = req.query.filter === 'needs_you' ? sql`not ${answered}` : req.query.filter === 'answered' ? answered : undefined;

      const rows = await db
        .select({
          id: messages.id,
          text: messages.text,
          createdAt: messages.createdAt,
          postId: sql<string | null>`${messages.meta}->>'postId'`,
          conversationId: messages.conversationId,
          mode: conversations.mode,
          customer: { id: customers.id, name: customers.name },
          channel: { id: channels.id, name: channels.name, type: channels.type },
        })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .innerJoin(customers, eq(customers.id, conversations.customerId))
        .innerJoin(channels, eq(channels.id, messages.channelId))
        .where(
          and(
            eq(messages.workspaceId, workspaceId),
            eq(messages.kind, 'comment'),
            eq(messages.direction, 'inbound'),
            filter,
            cursor ? or(lt(messages.createdAt, cursor.at), and(eq(messages.createdAt, cursor.at), lt(messages.id, cursor.id))) : undefined,
          ),
        )
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      const ids = page.map((c) => c.id);
      const replies = ids.length
        ? await db
            .select({
              id: messages.id,
              kind: messages.kind,
              sender: messages.sender,
              text: messages.text,
              delivery: messages.delivery,
              createdAt: messages.createdAt,
              replyTo: sql<string>`${messages.meta}->>'replyToMessageId'`,
            })
            .from(messages)
            .where(and(eq(messages.workspaceId, workspaceId), eq(messages.direction, 'outbound'), inArray(sql`${messages.meta}->>'replyToMessageId'`, ids)))
            .orderBy(messages.createdAt)
        : [];
      const last = page.at(-1);
      return {
        comments: page.map((c) => ({ ...c, replies: replies.filter((r) => r.replyTo === c.id).map(({ replyTo: _r, ...r }) => r) })),
        nextCursor: rows.length > limit && last ? makeCursor(last.createdAt, last.id) : null,
      };
    },
  );

  /** A public reply under one comment, from staff. */
  app.post<{ Params: { workspaceId: string; messageId: string }; Body: { text?: unknown } }>(
    '/workspaces/:workspaceId/comments/:messageId/reply',
    async (req, reply) => {
      if (!(await requireRole(db, req, reply, ALL_ROLES))) return reply;
      if (!isUuid(req.params.messageId)) return reply.code(404).send({ error: 'Comment not found' });
      const comment = await db.query.messages.findFirst({
        where: and(eq(messages.id, req.params.messageId), eq(messages.workspaceId, req.params.workspaceId), eq(messages.kind, 'comment')),
      });
      if (!comment) return reply.code(404).send({ error: 'Comment not found' });
      const conversation = await db.query.conversations.findFirst({ where: eq(conversations.id, comment.conversationId) });
      const sent = await sendHumanReply(deps, conversation!, req.body?.text, { sender: 'staff', userId: req.user.id }, comment);
      if (!sent.ok) return reply.code(sent.status).send({ error: sent.error });
      return reply.code(201).send({ message: sent.message });
    },
  );
};

function listChannels(db: Db, workspaceId: string) {
  return db
    .select({ id: channels.id, type: channels.type, name: channels.name, status: channels.status, lastError: channels.lastError, createdAt: channels.createdAt })
    .from(channels)
    .where(and(eq(channels.workspaceId, workspaceId), ne(channels.status, 'disconnected')))
    .orderBy(channels.createdAt);
}

function recentActivity(db: Db, workspaceId: string, limit: number, cursor?: { at: Date; id: string }) {
  return db
    .select({ id: activities.id, type: activities.type, text: activities.text, data: activities.data, createdAt: activities.createdAt })
    .from(activities)
    .where(
      and(
        eq(activities.workspaceId, workspaceId),
        cursor ? or(lt(activities.createdAt, cursor.at), and(eq(activities.createdAt, cursor.at), lt(activities.id, cursor.id))) : undefined,
      ),
    )
    .orderBy(desc(activities.createdAt), desc(activities.id))
    .limit(limit);
}
