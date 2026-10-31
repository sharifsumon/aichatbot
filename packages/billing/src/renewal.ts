import { and, eq, gte, inArray, isNotNull } from 'drizzle-orm';
import { activities, creditGrants, plans, workspaces, type Db } from '@agently/db';
import { billingMonth } from './credits.ts';

/**
 * Gives each paying shop its plan's AI credits for the current month, once.
 * Safe to run any number of times: a shop that already has this month's plan
 * grant is skipped. Trial shops keep the one grant they got at sign-up.
 */
export async function grantMonthlyCredits(db: Db, now = new Date()): Promise<number> {
  const { start, end } = billingMonth(now);
  const paying = await db
    .select({ id: workspaces.id, credits: plans.limits })
    .from(workspaces)
    .innerJoin(plans, eq(plans.id, workspaces.planId))
    .where(and(inArray(workspaces.status, ['active', 'past_due']), isNotNull(workspaces.planId)));
  if (paying.length === 0) return 0;

  const granted = await db
    .select({ workspaceId: creditGrants.workspaceId })
    .from(creditGrants)
    .where(
      and(
        inArray(creditGrants.workspaceId, paying.map((w) => w.id)),
        eq(creditGrants.reason, 'plan'),
        gte(creditGrants.createdAt, start),
        eq(creditGrants.expiresAt, end),
      ),
    );
  const done = new Set(granted.map((g) => g.workspaceId));
  const due = paying.filter((w) => !done.has(w.id) && w.credits.aiCreditsPerMonth > 0);
  for (const w of due) {
    await db.transaction(async (tx) => {
      await tx.insert(creditGrants).values({ workspaceId: w.id, reason: 'plan', credits: w.credits.aiCreditsPerMonth, expiresAt: end });
      await tx.insert(activities).values({
        workspaceId: w.id,
        type: 'credits.renewed',
        text: `${w.credits.aiCreditsPerMonth.toLocaleString('en')} AI credits added for this month`,
        data: { credits: w.credits.aiCreditsPerMonth },
      });
    });
  }
  return due.length;
}
