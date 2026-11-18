import { and, asc, eq, gte, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { DEFAULT_LIMITS, channelLimit, channelsInUse, creditSummary, limitsFor, mediaAllowance, mediaLimits, pagesInUse, planFor, seatsInUse } from '@agently/billing';
import { agents, plans, platformSettings, usageRecords, workspaces, type Db } from '@agently/db';
import { ALL_ROLES, MANAGERS, requireRole } from './guard.ts';
import { usedBytes } from './knowledge.ts';

/** The top-up pack when the super admin has not set credits.topUp in Platform settings. */
export const TOP_UP = { credits: 1000, priceBdt: '300.00', priceUsd: '3.00' };

async function topUpPack(db: Db): Promise<typeof TOP_UP> {
  const row = await db.query.platformSettings.findFirst({ where: eq(platformSettings.key, 'credits.topUp') });
  const v = row?.value as { credits?: number; priceBdt?: string; priceUsd?: string } | undefined;
  return v?.credits ? { credits: v.credits, priceBdt: String(v.priceBdt ?? TOP_UP.priceBdt), priceUsd: String(v.priceUsd ?? TOP_UP.priceUsd) } : TOP_UP;
}

/**
 * Billing page: the plan, AI credits this month with the 80% / 100% warning,
 * usage against each plan limit, and the plans to compare. Payments come later.
 */
export const billingRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.get<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/billing', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    const { workspaceId } = req.params;
    const now = new Date();
    const [ws, plan, credits, pages, seats, kbBytes, agentCount, available, whatsapp, instagram] = await Promise.all([
      db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) }),
      planFor(db, workspaceId),
      creditSummary(db, workspaceId, now),
      pagesInUse(db, workspaceId),
      seatsInUse(db, workspaceId, now),
      usedBytes(db, workspaceId),
      db.select({ n: sql<number>`count(*)::int` }).from(agents).where(eq(agents.workspaceId, workspaceId)),
      db.select().from(plans).where(eq(plans.active, true)).orderBy(asc(plans.priceBdt)),
      channelsInUse(db, workspaceId, 'whatsapp'),
      channelsInUse(db, workspaceId, 'instagram'),
    ]);
    const limits = plan?.limits ?? DEFAULT_LIMITS;
    const media = await mediaAllowance(db, workspaceId, limits, now);
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
        whatsapp: { used: whatsapp, limit: channelLimit(limits, 'whatsapp') },
        instagram: { used: instagram, limit: channelLimit(limits, 'instagram') },
        agents: { used: agentCount[0]?.n ?? 0, limit: limits.agents },
        staffSeats: { used: seats.members + seats.pendingInvites, limit: limits.staffSeats },
        knowledgeBase: { usedBytes: kbBytes, limitBytes: limits.knowledgeBaseMb * 1024 * 1024 },
        images: media.images,
        videoSeconds: media.videoSeconds,
        topUpCredits: media.topUpCredits,
      },
      plans: available
        .filter((p) => !p.trialDays)
        .map((p) => ({
          key: p.key,
          name: p.name,
          priceBdt: p.priceBdt,
          priceUsd: p.priceUsd,
          limits: {
            ...p.limits,
            whatsappNumbers: channelLimit(p.limits, 'whatsapp'),
            instagramAccounts: channelLimit(p.limits, 'instagram'),
            imagesPerMonth: mediaLimits(p.limits).images,
            videoSecondsPerMonth: mediaLimits(p.limits).videoSeconds,
          },
          current: p.id === plan?.id,
        })),
      topUp: await topUpPack(db),
      // Upgrades and top-ups need the payment gateways; until then the Agently team changes plans.
      paymentsAvailable: false,
    };
  });

  /** AI images and seconds of AI video left this month, for the Generate image and video pages. Any team member may see it. */
  app.get<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/media-allowance', async (req, reply) => {
    if (!(await requireRole(db, req, reply, ALL_ROLES))) return reply;
    return mediaAllowance(db, req.params.workspaceId, await limitsFor(db, req.params.workspaceId));
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
