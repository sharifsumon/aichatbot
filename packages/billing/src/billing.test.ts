/** Needs DATABASE_URL pointing at a migrated database; skipped otherwise. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { activities, createDb, creditGrants, plans, usageRecords, workspaces, type Db } from '@agently/db';
import { billingMonth, creditSummary, creditsRemaining, grantMonthlyCredits, noteCreditWarnings } from './index.ts';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL not set';
let db: Db;
let close: () => Promise<void>;

before(() => {
  if (!skip) ({ db, close } = createDb(url!, { max: 4 }));
});
after(async () => {
  if (!skip) await close();
});

async function paidShop(credits = 100) {
  const [plan] = await db
    .insert(plans)
    .values({ key: `test-${randomBytes(4).toString('hex')}`, name: 'Test plan', priceBdt: '990', priceUsd: '9', limits: { pages: 1, agents: 1, aiCreditsPerMonth: credits, knowledgeBaseMb: 100, staffSeats: 2 } })
    .returning();
  const [ws] = await db.insert(workspaces).values({ name: 'Shop', status: 'active', planId: plan!.id }).returning();
  return ws!;
}

const use = (workspaceId: string, aiReplies: number, day = new Date().toISOString().slice(0, 10)) =>
  db.insert(usageRecords).values({ workspaceId, day, model: `m-${randomBytes(3).toString('hex')}`, aiReplies });

test('billing month runs from the 1st to the 1st, UTC', () => {
  const { start, end } = billingMonth(new Date('2026-12-31T23:30:00Z'));
  assert.equal(start.toISOString(), '2026-12-01T00:00:00.000Z');
  assert.equal(end.toISOString(), '2027-01-01T00:00:00.000Z');
});

test('monthly credits: granted once per month to paying shops, never twice', { skip }, async () => {
  const ws = await paidShop(100);
  const [trial] = await db.insert(workspaces).values({ name: 'Trial shop', status: 'trial', planId: ws.planId }).returning();
  await grantMonthlyCredits(db);
  await grantMonthlyCredits(db);
  const grants = await db.select().from(creditGrants).where(eq(creditGrants.workspaceId, ws.id));
  assert.equal(grants.length, 1);
  assert.equal(grants[0]!.credits, 100);
  assert.equal(grants[0]!.expiresAt.toISOString(), billingMonth().end.toISOString());
  assert.equal((await db.select().from(creditGrants).where(eq(creditGrants.workspaceId, trial!.id))).length, 0);
  assert.equal(await creditsRemaining(db, ws.id), 100);
});

test('credit warnings at 80% and 100%, each once a month', { skip }, async () => {
  const ws = await paidShop(10);
  await grantMonthlyCredits(db);
  await use(ws.id, 7);
  assert.equal(await noteCreditWarnings(db, ws.id), null);
  assert.equal((await creditSummary(db, ws.id)).warning, null);

  await use(ws.id, 1);
  assert.equal(await noteCreditWarnings(db, ws.id), 'low');
  assert.equal(await noteCreditWarnings(db, ws.id), null);
  const s = await creditSummary(db, ws.id);
  assert.deepEqual([s.granted, s.used, s.remaining, s.percentUsed, s.warning], [10, 8, 2, 80, 'low']);

  await use(ws.id, 5);
  assert.equal(await noteCreditWarnings(db, ws.id), 'out');
  assert.equal(await noteCreditWarnings(db, ws.id), null);
  const out = await creditSummary(db, ws.id);
  assert.equal(out.remaining, 0);
  assert.equal(out.percentUsed, 100);

  const feed = await db.select().from(activities).where(and(eq(activities.workspaceId, ws.id)));
  assert.deepEqual(feed.map((a) => a.type).sort(), ['credits.low', 'credits.out', 'credits.renewed']);

  // A top-up switches the bot back on.
  await db.insert(creditGrants).values({ workspaceId: ws.id, reason: 'topup', credits: 1000, expiresAt: billingMonth().end });
  assert.equal(await creditsRemaining(db, ws.id), 1010 - 13);
  assert.equal((await creditSummary(db, ws.id)).warning, null);
});
