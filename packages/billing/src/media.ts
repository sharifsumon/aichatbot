import { and, eq, gt, gte, inArray, sql } from 'drizzle-orm';
import { creditGrants, mediaUsage, type Db, type PlanLimits } from '@agently/db';
import { billingMonth, creditsRemaining } from './credits.ts';

export type MediaKind = 'image' | 'video';

/**
 * AI images and seconds of AI video a shop can make each billing month.
 * `limit: null` means the plan sets no cap; AI credits still apply either way.
 */
export interface MediaAllowance {
  images: { used: number; limit: number | null };
  videoSeconds: { used: number; limit: number | null };
  /** Top-up credits left to pay for images and video beyond the plan's allowance. */
  topUpCredits: number;
  periodEnd: Date;
}

/** The plan's caps; a plan saved without them has none. */
export function mediaLimits(limits: PlanLimits): { images: number | null; videoSeconds: number | null } {
  return { images: limits.imagesPerMonth ?? null, videoSeconds: limits.videoSecondsPerMonth ?? null };
}

/** Images (count) or video seconds taken from the plan's allowance this month, including ones still being made. */
export async function mediaUsed(db: Db, workspaceId: string, kind: MediaKind, now = new Date()): Promise<number> {
  const { start } = billingMonth(now);
  const [row] = await db
    .select({ n: sql<number>`coalesce(sum(${mediaUsage.amount}), 0)::int` })
    .from(mediaUsage)
    .where(and(eq(mediaUsage.workspaceId, workspaceId), eq(mediaUsage.kind, kind), gte(mediaUsage.createdAt, start)));
  return row?.n ?? 0;
}

export async function mediaAllowance(db: Db, workspaceId: string, limits: PlanLimits, now = new Date()): Promise<MediaAllowance> {
  const caps = mediaLimits(limits);
  const [images, seconds, topUp] = await Promise.all([mediaUsed(db, workspaceId, 'image', now), mediaUsed(db, workspaceId, 'video', now), topUpCreditsLeft(db, workspaceId, now)]);
  return { images: { used: images, limit: caps.images }, videoSeconds: { used: seconds, limit: caps.videoSeconds }, topUpCredits: topUp, periodEnd: billingMonth(now).end };
}

/**
 * Top-up credits left for images and video beyond the plan's allowance: the
 * unexpired top-ups bought, minus what extra images and video used this month.
 * Never more than the credits left overall, since replies spend from the same pool.
 */
export async function topUpCreditsLeft(db: Db, workspaceId: string, now = new Date()): Promise<number> {
  const { start } = billingMonth(now);
  const [[bought], [spent], remaining] = await Promise.all([
    db
      .select({ n: sql<number>`coalesce(sum(${creditGrants.credits}), 0)::int` })
      .from(creditGrants)
      .where(and(eq(creditGrants.workspaceId, workspaceId), eq(creditGrants.reason, 'topup'), gt(creditGrants.expiresAt, now))),
    db
      .select({ n: sql<number>`coalesce(sum(${mediaUsage.extraCredits}), 0)::int` })
      .from(mediaUsage)
      .where(and(eq(mediaUsage.workspaceId, workspaceId), gte(mediaUsage.createdAt, start))),
    creditsRemaining(db, workspaceId, now),
  ]);
  return Math.max(0, Math.min((bought?.n ?? 0) - (spent?.n ?? 0), remaining));
}

/**
 * Runs `fn` while holding a per-shop lock, so two requests at once can't both
 * take the last image or the last seconds of video. Check with `mediaUsed`
 * and record with `takeMedia` inside it.
 */
export async function withMediaLock<T>(db: Db, workspaceId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`media:${workspaceId}`}))`);
    return fn(tx as unknown as Db);
  });
}

/** Records what an image or video takes: `amount` from the plan's allowance, `extra` paid with top-up credits. */
export async function takeMedia(
  db: Db,
  input: { workspaceId: string; kind: MediaKind; amount: number; extra?: number; extraCredits?: number; sourceId: string },
): Promise<void> {
  await db.insert(mediaUsage).values(input);
}

/**
 * A finished video counts its real length: the plan's share first, up to what
 * was held from it, and the rest as extra at `creditsPerSecond` top-up credits.
 */
export async function settleMedia(db: Db, sourceId: string, seconds: number, creditsPerSecond: number): Promise<void> {
  const row = await db.query.mediaUsage.findFirst({ where: eq(mediaUsage.sourceId, sourceId) });
  if (!row) return;
  // A row that took nothing from a capped plan (no cap, or all extra) keeps that split.
  const fromPlan = row.extra === 0 ? seconds : Math.min(seconds, row.amount);
  const extra = seconds - fromPlan;
  await db.update(mediaUsage).set({ amount: fromPlan, extra, extraCredits: extra * creditsPerSecond }).where(eq(mediaUsage.sourceId, sourceId));
}

/** A failed image or video gives its share back. */
export async function releaseMedia(db: Db, sourceIds: string[]): Promise<void> {
  if (sourceIds.length) await db.delete(mediaUsage).where(inArray(mediaUsage.sourceId, sourceIds));
}
