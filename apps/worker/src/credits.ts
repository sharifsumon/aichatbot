import { and, eq, gt, gte, sql } from 'drizzle-orm';
import { creditGrants, usageRecords, type Db } from '@agently/db';

/**
 * AI credits left this month: unexpired grants (plan allowance, top-ups,
 * adjustments) minus AI replies sent since the 1st. Grants expire at the
 * end of the billing month, so both sides cover the same period.
 */
export async function creditsRemaining(db: Db, workspaceId: string, now = new Date()): Promise<number> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
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
