import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { mediaUsage, type Db, type PlanLimits } from '@agently/db';
import { billingMonth } from './credits.ts';

export type MediaKind = 'image' | 'video';

/**
 * AI images and seconds of AI video a shop can make each billing month.
 * `limit: null` means the plan sets no cap; AI credits still apply either way.
 */
export interface MediaAllowance {
  images: { used: number; limit: number | null };
  videoSeconds: { used: number; limit: number | null };
  periodEnd: Date;
}

/** The plan's caps; a plan saved without them has none. */
export function mediaLimits(limits: PlanLimits): { images: number | null; videoSeconds: number | null } {
  return { images: limits.imagesPerMonth ?? null, videoSeconds: limits.videoSecondsPerMonth ?? null };
}

/** Images (count) or video seconds taken this month, including ones still being made. */
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
  const [images, seconds] = await Promise.all([mediaUsed(db, workspaceId, 'image', now), mediaUsed(db, workspaceId, 'video', now)]);
  return { images: { used: images, limit: caps.images }, videoSeconds: { used: seconds, limit: caps.videoSeconds }, periodEnd: billingMonth(now).end };
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

/** Records what an image or video takes from the allowance. */
export async function takeMedia(db: Db, input: { workspaceId: string; kind: MediaKind; amount: number; sourceId: string }): Promise<void> {
  await db.insert(mediaUsage).values(input);
}

/** A finished video counts its real length. */
export async function settleMedia(db: Db, sourceId: string, amount: number): Promise<void> {
  await db.update(mediaUsage).set({ amount }).where(eq(mediaUsage.sourceId, sourceId));
}

/** A failed image or video gives its share back. */
export async function releaseMedia(db: Db, sourceIds: string[]): Promise<void> {
  if (sourceIds.length) await db.delete(mediaUsage).where(inArray(mediaUsage.sourceId, sourceIds));
}
