import { and, desc, eq, gt, gte, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { DEFAULT_LIMITS, billingMonth } from '@agently/billing';
import { activities, creditGrants, messages, plans, usageRecords, workspaces, type Db } from '@agently/db';
import { requirePerm } from './guard.ts';

const today = () => new Date().toISOString().slice(0, 10);

/** Overview tiles and the AI usage page. */
export const adminInsightRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.get('/overview', async (req, reply) => {
    if (!(await requirePerm(req, reply, 'usage.read'))) return reply;
    const now = new Date();
    const dayStart = new Date(`${today()}T00:00:00Z`);
    const monthStart = billingMonth(now).start.toISOString().slice(0, 10);

    const [byStatus, signups, messagesToday, aiToday, handoffsToday, monthCost, mrr] = await Promise.all([
      db.select({ status: workspaces.status, n: sql<number>`count(*)::int` }).from(workspaces).groupBy(workspaces.status),
      db
        .select({
          last7: sql<number>`count(*) filter (where ${workspaces.createdAt} >= now() - interval '7 days')::int`,
          last30: sql<number>`count(*) filter (where ${workspaces.createdAt} >= now() - interval '30 days')::int`,
        })
        .from(workspaces),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(messages)
        .where(and(eq(messages.direction, 'inbound'), gte(messages.createdAt, dayStart))),
      db
        .select({
          replies: sql<number>`coalesce(sum(${usageRecords.aiReplies}), 0)::int`,
          failed: sql<number>`coalesce(sum(${usageRecords.failedCalls}), 0)::int`,
        })
        .from(usageRecords)
        .where(eq(usageRecords.day, today())),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(activities)
        .where(and(eq(activities.type, 'conversation.handoff'), gte(activities.createdAt, dayStart))),
      db.select({ usd: sql<string>`coalesce(sum(${usageRecords.costUsd}), 0)::text` }).from(usageRecords).where(gte(usageRecords.day, monthStart)),
      // Monthly recurring revenue from paid plans on active shops, by currency.
      db
        .select({
          bdt: sql<string>`coalesce(sum(${plans.priceBdt}) filter (where ${workspaces.billingCountry} = 'BD'), 0)::text`,
          usd: sql<string>`coalesce(sum(${plans.priceUsd}) filter (where ${workspaces.billingCountry} <> 'BD'), 0)::text`,
        })
        .from(workspaces)
        .innerJoin(plans, eq(plans.id, workspaces.planId))
        .where(and(eq(workspaces.status, 'active'), sql`${plans.trialDays} is null`)),
    ]);
    const status = Object.fromEntries(byStatus.map((s) => [s.status, s.n]));
    const replies = aiToday[0]?.replies ?? 0;
    const failed = aiToday[0]?.failed ?? 0;
    return {
      tenants: { trial: status.trial ?? 0, active: status.active ?? 0, pastDue: status.past_due ?? 0, suspended: status.suspended ?? 0 },
      signups: signups[0],
      today: {
        customerMessages: messagesToday[0]?.n ?? 0,
        aiReplies: replies,
        handoffs: handoffsToday[0]?.n ?? 0,
        failedAiCalls: failed,
        // Failed model calls out of all model calls today.
        errorRate: replies + failed > 0 ? failed / (replies + failed) : 0,
      },
      aiCostThisMonthUsd: monthCost[0]?.usd ?? '0',
      mrr: mrr[0],
      // Payments are not online yet.
      failedPayments: null,
    };
  });

  /**
   * AI usage: per tenant and per model over a range, top spenders, and
   * shops at or near their credit limit.
   */
  app.get<{ Querystring: { days?: string } }>('/usage', async (req, reply) => {
    if (!(await requirePerm(req, reply, 'usage.read'))) return reply;
    const days = Math.min(90, Math.max(1, Number.parseInt(req.query.days ?? '30', 10) || 30));
    const from = new Date(Date.now() - (days - 1) * 864e5).toISOString().slice(0, 10);
    const now = new Date();
    const { start } = billingMonth(now);

    const [daily, byModel, topTenants] = await Promise.all([
      db
        .select({
          day: usageRecords.day,
          aiReplies: sql<number>`sum(${usageRecords.aiReplies})::int`,
          inputTokens: sql<number>`sum(${usageRecords.inputTokens})::bigint`.mapWith(Number),
          outputTokens: sql<number>`sum(${usageRecords.outputTokens})::bigint`.mapWith(Number),
          costUsd: sql<string>`sum(${usageRecords.costUsd})::text`,
          failedCalls: sql<number>`sum(${usageRecords.failedCalls})::int`,
        })
        .from(usageRecords)
        .where(gte(usageRecords.day, from))
        .groupBy(usageRecords.day)
        .orderBy(usageRecords.day),
      db
        .select({
          model: usageRecords.model,
          aiReplies: sql<number>`sum(${usageRecords.aiReplies})::int`,
          inputTokens: sql<number>`sum(${usageRecords.inputTokens})::bigint`.mapWith(Number),
          outputTokens: sql<number>`sum(${usageRecords.outputTokens})::bigint`.mapWith(Number),
          costUsd: sql<string>`sum(${usageRecords.costUsd})::text`,
          failedCalls: sql<number>`sum(${usageRecords.failedCalls})::int`,
        })
        .from(usageRecords)
        .where(gte(usageRecords.day, from))
        .groupBy(usageRecords.model),
      db
        .select({
          workspaceId: usageRecords.workspaceId,
          name: workspaces.name,
          aiReplies: sql<number>`sum(${usageRecords.aiReplies})::int`,
          costUsd: sql<string>`sum(${usageRecords.costUsd})::text`,
          failedCalls: sql<number>`sum(${usageRecords.failedCalls})::int`,
        })
        .from(usageRecords)
        .innerJoin(workspaces, eq(workspaces.id, usageRecords.workspaceId))
        .where(gte(usageRecords.day, from))
        .groupBy(usageRecords.workspaceId, workspaces.name)
        .orderBy(desc(sql`sum(${usageRecords.costUsd})`))
        .limit(20),
    ]);

    // Credits used this month against granted, for every shop that used any.
    const used = await db
      .select({ workspaceId: usageRecords.workspaceId, used: sql<number>`sum(${usageRecords.aiReplies})::int` })
      .from(usageRecords)
      .where(gte(usageRecords.day, start.toISOString().slice(0, 10)))
      .groupBy(usageRecords.workspaceId);
    const ids = used.filter((u) => u.used > 0).map((u) => u.workspaceId);
    const granted = ids.length
      ? await db
          .select({ workspaceId: creditGrants.workspaceId, granted: sql<number>`sum(${creditGrants.credits})::int` })
          .from(creditGrants)
          .where(and(inArray(creditGrants.workspaceId, ids), gt(creditGrants.expiresAt, now)))
          .groupBy(creditGrants.workspaceId)
      : [];
    const names = ids.length ? await db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces).where(inArray(workspaces.id, ids)) : [];
    const nearLimit = used
      .map((u) => {
        const g = granted.find((x) => x.workspaceId === u.workspaceId)?.granted ?? 0;
        return { workspaceId: u.workspaceId, name: names.find((n) => n.id === u.workspaceId)?.name ?? '', used: u.used, granted: g, percentUsed: g > 0 ? Math.floor((u.used / g) * 100) : 100 };
      })
      .filter((t) => t.percentUsed >= 80)
      .sort((a, b) => b.percentUsed - a.percentUsed);

    return { days: daily, models: byModel, topTenants, nearLimit, defaultLimits: DEFAULT_LIMITS };
  });
};
