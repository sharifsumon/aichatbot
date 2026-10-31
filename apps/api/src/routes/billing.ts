import { and, asc, eq, gte, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { DEFAULT_LIMITS, creditSummary, pagesInUse, planFor, seatsInUse } from '@agently/billing';
import { agents, plans, usageRecords, workspaces, type Db } from '@agently/db';
import { MANAGERS, requireRole } from './guard.ts';
import { usedBytes } from './knowledge.ts';

/** The demo top-up pack from the spec; becomes a platform setting with the payment gateways. */
export const TOP_UP = { credits: 1000, priceBdt: '300.00', priceUsd: '3.00' };

/**
 * Billing page: the plan, AI credits this month with the 80% / 100% warning,
 * usage against each plan limit, and the plans to compare. Payments come later.
 */
export const billingRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.get<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/billing', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    const { workspaceId } = req.params;
    const now = new Date();
    const [ws, plan, credits, pages, seats, kbBytes, agentCount, available] = await Promise.all([
      db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) }),
      planFor(db, workspaceId),
      creditSummary(db, workspaceId, now),
      pagesInUse(db, workspaceId),
      seatsInUse(db, workspaceId, now),
      usedBytes(db, workspaceId),
      db.select({ n: sql<number>`count(*)::int` }).from(agents).where(eq(agents.workspaceId, workspaceId)),
      db.select().from(plans).where(eq(plans.active, true)).orderBy(asc(plans.priceBdt)),
    ]);
    const limits = plan?.limits ?? DEFAULT_LIMITS;
    const trialEnded = ws!.status === 'trial' && !!ws!.trialEndsAt && ws!.trialEndsAt <= now;
    // BD shops pay in taka through SSLCommerz or bKash; everyone else in dollars through Stripe.
    const currency = ws!.billingCountry === 'BD' ? 'BDT' : 'USD';

    return {
      status: ws!.status,
      trialEndsAt: ws!.trialEndsAt,
      trialEnded,
      currency,
      plan: plan ? { key: plan.key, name: plan.name, priceBdt: plan.priceBdt, priceUsd: plan.priceUsd } : null,
      credits,
      usage: {
        pages: { used: pages, limit: limits.pages },
        agents: { used: agentCount[0]?.n ?? 0, limit: limits.agents },
        staffSeats: { used: seats.members + seats.pendingInvites, limit: limits.staffSeats },
        knowledgeBase: { usedBytes: kbBytes, limitBytes: limits.knowledgeBaseMb * 1024 * 1024 },
      },
      plans: available
        .filter((p) => !p.trialDays)
        .map((p) => ({ key: p.key, name: p.name, priceBdt: p.priceBdt, priceUsd: p.priceUsd, limits: p.limits, current: p.id === plan?.id })),
      topUp: TOP_UP,
      // Upgrades and top-ups need the payment gateways; until then the Agently team changes plans.
      paymentsAvailable: false,
    };
  });

  /** AI replies per day for the usage chart; at most 90 days. */
  app.get<{ Params: { workspaceId: string }; Querystring: { days?: string } }>('/workspaces/:workspaceId/usage', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    const days = Math.min(90, Math.max(1, Number.parseInt(req.query.days ?? '30', 10) || 30));
    const from = new Date(Date.now() - (days - 1) * 864e5).toISOString().slice(0, 10);
    const rows = await db
      .select({ day: usageRecords.day, aiReplies: sql<number>`sum(${usageRecords.aiReplies})::int` })
      .from(usageRecords)
      .where(and(eq(usageRecords.workspaceId, req.params.workspaceId), gte(usageRecords.day, from)))
      .groupBy(usageRecords.day)
      .orderBy(asc(usageRecords.day));
    // Every day in the range, zero when nothing happened, so the chart has no gaps.
    const byDay = new Map(rows.map((r) => [r.day, r.aiReplies]));
    const series = Array.from({ length: days }, (_, i) => {
      const day = new Date(Date.parse(from) + i * 864e5).toISOString().slice(0, 10);
      return { day, aiReplies: byDay.get(day) ?? 0 };
    });
    return { days: series };
  });
};
