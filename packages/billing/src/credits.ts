import { and, eq, gt, gte, sql } from 'drizzle-orm';
import { activities, creditGrants, usageRecords, type Db } from '@agently/db';

/** The 1st of this month and of next month, UTC. Credits and usage are counted per calendar month. */
export function billingMonth(now = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

export interface CreditSummary {
  granted: number;
  used: number;
  remaining: number;
  /** 0–100, rounded down; 100 when nothing was granted. */
  percentUsed: number;
  /** 'low' from 80% used, 'out' at 100%. The dashboard shows a banner for both. */
  warning: 'low' | 'out' | null;
  periodEnd: Date;
}

/** Credits granted and used this month, for the billing page and the low-credit warnings. */
export async function creditSummary(db: Db, workspaceId: string, now = new Date()): Promise<CreditSummary> {
  const { start, end } = billingMonth(now);
  const [[granted], [used]] = await Promise.all([
    db
      .select({ total: sql<string>`coalesce(sum(${creditGrants.credits}), 0)` })
      .from(creditGrants)
      .where(and(eq(creditGrants.workspaceId, workspaceId), gt(creditGrants.expiresAt, now))),
    db
      .select({ total: sql<string>`coalesce(sum(${usageRecords.aiReplies}), 0)` })
      .from(usageRecords)
      .where(and(eq(usageRecords.workspaceId, workspaceId), gte(usageRecords.day, start.toISOString().slice(0, 10)))),
  ]);
  const g = Number(granted?.total ?? 0);
  const u = Number(used?.total ?? 0);
  const percentUsed = g > 0 ? Math.min(100, Math.floor((u / g) * 100)) : 100;
  return {
    granted: g,
    used: u,
    remaining: Math.max(0, g - u),
    percentUsed,
    warning: percentUsed >= 100 ? 'out' : percentUsed >= 80 ? 'low' : null,
    periodEnd: end,
  };
}

/**
 * Writes a "credits low" (80%) or "credits used up" (100%) entry to the
 * shop's activity feed, once per threshold per month. Called after each AI reply.
 */
export async function noteCreditWarnings(db: Db, workspaceId: string, now = new Date()): Promise<'low' | 'out' | null> {
  const summary = await creditSummary(db, workspaceId, now);
  if (!summary.warning) return null;
  const type = summary.warning === 'out' ? 'credits.out' : 'credits.low';
  const { start } = billingMonth(now);
  const already = await db.query.activities.findFirst({
    columns: { id: true },
    where: and(eq(activities.workspaceId, workspaceId), eq(activities.type, type), gte(activities.createdAt, start)),
  });
  if (already) return null;
  await db.insert(activities).values({
    workspaceId,
    type,
    text:
      summary.warning === 'out'
        ? 'AI credits are used up. The bot has stopped replying; messages still arrive in the inbox. Top up or upgrade to switch it back on.'
        : `${summary.percentUsed}% of this month's AI credits are used.`,
    data: { granted: summary.granted, used: summary.used },
  });
  return summary.warning;
}

/**
 * AI credits left this month: unexpired grants (plan allowance, top-ups,
 * adjustments) minus AI replies sent since the 1st. Grants expire at the
 * end of the billing month, so both sides cover the same period.
 */
export async function creditsRemaining(db: Db, workspaceId: string, now = new Date()): Promise<number> {
  const monthStart = billingMonth(now).start.toISOString().slice(0, 10);
  const [[granted], [used]] = await Promise.all([
    db
      .select({ total: sql<string>`coalesce(sum(${creditGrants.credits}), 0)` })
      .from(creditGrants)
      .where(and(eq(creditGrants.workspaceId, workspaceId), gt(creditGrants.expiresAt, now))),
    db
      .select({ total: sql<string>`coalesce(sum(${usageRecords.aiReplies}), 0)` })
      .from(usageRecords)
      .where(and(eq(usageRecords.workspaceId, workspaceId), gte(usageRecords.day, monthStart))),
  ]);
  return Number(granted?.total ?? 0) - Number(used?.total ?? 0);
}

export async function recordUsage(
  db: Db,
  input: { workspaceId: string; model: string; aiReplies: number; inputTokens: number; outputTokens: number; costUsd: number; failed?: boolean },
): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const failedCalls = input.failed ? 1 : 0;
  await db
    .insert(usageRecords)
    .values({
      workspaceId: input.workspaceId,
      day,
      model: input.model,
      aiReplies: input.aiReplies,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      costUsd: input.costUsd.toFixed(6),
      failedCalls,
    })
    .onConflictDoUpdate({
      target: [usageRecords.workspaceId, usageRecords.day, usageRecords.model],
      set: {
        aiReplies: sql`${usageRecords.aiReplies} + ${input.aiReplies}`,
        inputTokens: sql`${usageRecords.inputTokens} + ${input.inputTokens}`,
        outputTokens: sql`${usageRecords.outputTokens} + ${input.outputTokens}`,
        costUsd: sql`${usageRecords.costUsd} + ${input.costUsd.toFixed(6)}`,
        failedCalls: sql`${usageRecords.failedCalls} + ${failedCalls}`,
      },
    });
}
