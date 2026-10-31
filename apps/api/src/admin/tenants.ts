import { and, asc, desc, eq, gte, ilike, isNotNull, lt, ne, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { billingMonth, creditSummary } from '@agently/billing';
import {
  activities,
  channels,
  conversations,
  creditGrants,
  knowledgeSources,
  memberships,
  orders,
  plans,
  products,
  subscriptions,
  usageRecords,
  users,
  workspaces,
  type Db,
} from '@agently/db';
import { isUuid, makeCursor, pageLimit, parseCursor } from '../routes/guard.ts';
import { parseBody } from '../routes/validate.ts';
import { audit, requirePerm } from './guard.ts';

const STATUSES = ['trial', 'active', 'past_due', 'suspended'] as const;

const suspendBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
const extendBody = z.object({ days: z.number().int().min(1).max(90) }).strict();
const planBody = z.object({ planKey: z.string().trim().min(1).max(60) }).strict();
const creditsBody = z.object({ credits: z.number().int().min(-100_000).max(100_000).refine((n) => n !== 0, 'must not be 0'), note: z.string().trim().min(3).max(300) }).strict();

type Params = { workspaceId: string };

/** Tenants: every shop, with what it uses this month, and the actions support and finance take. */
export const adminTenantRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.get<{ Querystring: { q?: string; status?: string; plan?: string; cursor?: string; limit?: string } }>('/tenants', async (req, reply) => {
    if (!(await requirePerm(req, reply, 'tenants.read'))) return reply;
    const limit = pageLimit(req.query.limit);
    const cursor = parseCursor(req.query.cursor);
    const status = STATUSES.find((s) => s === req.query.status);
    const q = req.query.q?.trim();
    const monthStart = billingMonth().start.toISOString().slice(0, 10);

    const owner = db
      .select({ workspaceId: memberships.workspaceId, name: users.name, email: users.email })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.role, 'owner'))
      .as('owner');

    const rows = await db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        status: workspaces.status,
        trialEndsAt: workspaces.trialEndsAt,
        createdAt: workspaces.createdAt,
        plan: { key: plans.key, name: plans.name },
        owner: { name: owner.name, email: owner.email },
        pagesConnected: sql<number>`(select count(*)::int from ${channels} where ${channels.workspaceId} = ${workspaces.id} and ${channels.status} = 'connected')`,
        aiRepliesThisMonth: sql<number>`(select coalesce(sum(${usageRecords.aiReplies}), 0)::int from ${usageRecords} where ${usageRecords.workspaceId} = ${workspaces.id} and ${usageRecords.day} >= ${monthStart})`,
        aiCostThisMonth: sql<string>`(select coalesce(sum(${usageRecords.costUsd}), 0)::text from ${usageRecords} where ${usageRecords.workspaceId} = ${workspaces.id} and ${usageRecords.day} >= ${monthStart})`,
        lastActiveAt: sql<Date | null>`(select max(${conversations.lastMessageAt}) from ${conversations} where ${conversations.workspaceId} = ${workspaces.id})`.mapWith((v) => (v ? new Date(v) : null)),
      })
      .from(workspaces)
      .leftJoin(plans, eq(plans.id, workspaces.planId))
      .leftJoin(owner, eq(owner.workspaceId, workspaces.id))
      .where(
        and(
          status ? eq(workspaces.status, status) : undefined,
          req.query.plan ? eq(plans.key, req.query.plan) : undefined,
          q ? or(ilike(workspaces.name, `%${escapeLike(q)}%`), ilike(owner.email, `%${escapeLike(q)}%`), ilike(owner.name, `%${escapeLike(q)}%`), isUuid(q) ? eq(workspaces.id, q) : undefined) : undefined,
          cursor ? or(lt(workspaces.createdAt, cursor.at), and(eq(workspaces.createdAt, cursor.at), lt(workspaces.id, cursor.id))) : undefined,
        ),
      )
      .orderBy(desc(workspaces.createdAt), desc(workspaces.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      tenants: page.map((t) => ({ ...t, plan: t.plan?.key ? t.plan : null, owner: t.owner?.email || t.owner?.name ? t.owner : null })),
      nextCursor: rows.length > limit && last ? makeCursor(last.createdAt, last.id) : null,
    };
  });

  /** Everything about one shop. Viewing is audited. */
  app.get<{ Params: Params }>('/tenants/:workspaceId', async (req, reply) => {
    if (!(await requirePerm(req, reply, 'tenants.read'))) return reply;
    const ws = await findTenant(db, req.params.workspaceId);
    if (!ws) return reply.code(404).send({ error: 'Tenant not found' });
    const from = new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);

    const [members, channelRows, knowledge, productCount, orderCount, usage, credits, subs, plan] = await Promise.all([
      db
        .select({ userId: users.id, name: users.name, email: users.email, role: memberships.role, joinedAt: memberships.createdAt })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(memberships.workspaceId, ws.id))
        .orderBy(asc(memberships.createdAt)),
      db
        .select({ id: channels.id, type: channels.type, name: channels.name, status: channels.status, lastError: channels.lastError, updatedAt: channels.updatedAt })
        .from(channels)
        .where(and(eq(channels.workspaceId, ws.id), ne(channels.status, 'disconnected'))),
      db
        .select({ status: knowledgeSources.status, n: sql<number>`count(*)::int` })
        .from(knowledgeSources)
        .where(eq(knowledgeSources.workspaceId, ws.id))
        .groupBy(knowledgeSources.status),
      db.select({ n: sql<number>`count(*)::int` }).from(products).where(and(eq(products.workspaceId, ws.id), ne(products.status, 'archived'))),
      db.select({ n: sql<number>`count(*)::int` }).from(orders).where(eq(orders.workspaceId, ws.id)),
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
        .where(and(eq(usageRecords.workspaceId, ws.id), gte(usageRecords.day, from)))
        .groupBy(usageRecords.day)
        .orderBy(asc(usageRecords.day)),
      creditSummary(db, ws.id),
      db.select().from(subscriptions).where(eq(subscriptions.workspaceId, ws.id)).orderBy(desc(subscriptions.createdAt)),
      ws.planId ? db.query.plans.findFirst({ where: eq(plans.id, ws.planId) }) : undefined,
    ]);
    await audit(db, req, 'tenant.viewed', { workspaceId: ws.id, targetType: 'workspace', targetId: ws.id });
    return {
      tenant: { ...ws, plan: plan ? { key: plan.key, name: plan.name, limits: plan.limits } : null },
      members,
      channels: channelRows,
      knowledge: Object.fromEntries(knowledge.map((k) => [k.status, k.n])),
      counts: { products: productCount[0]?.n ?? 0, orders: orderCount[0]?.n ?? 0 },
      usage,
      credits,
      subscriptions: subs,
    };
  });

  /** Stops the bot at once (the reply job checks status) and shows the owner why. */
  app.post<{ Params: Params }>('/tenants/:workspaceId/suspend', async (req, reply) => {
    if (!(await requirePerm(req, reply, 'tenants.manage'))) return reply;
    const ws = await findTenant(db, req.params.workspaceId);
    if (!ws) return reply.code(404).send({ error: 'Tenant not found' });
    const body = await parseBody(suspendBody, req.body, reply);
    if (!body) return reply;
    if (ws.status === 'suspended') return reply.code(409).send({ error: 'This tenant is already suspended' });
    await db.update(workspaces).set({ status: 'suspended', suspendedReason: body.reason }).where(eq(workspaces.id, ws.id));
    await db.insert(activities).values({ workspaceId: ws.id, type: 'workspace.suspended', text: `Agently suspended this shop: ${body.reason}`, data: {} });
    await audit(db, req, 'tenant.suspended', { workspaceId: ws.id, targetType: 'workspace', targetId: ws.id, data: { reason: body.reason, previousStatus: ws.status } });
    return reply.code(204).send();
  });

  app.post<{ Params: Params }>('/tenants/:workspaceId/reactivate', async (req, reply) => {
    if (!(await requirePerm(req, reply, 'tenants.manage'))) return reply;
    const ws = await findTenant(db, req.params.workspaceId);
    if (!ws) return reply.code(404).send({ error: 'Tenant not found' });
    if (ws.status !== 'suspended') return reply.code(409).send({ error: 'This tenant is not suspended' });
    // Back to trial while the trial still runs; otherwise active.
    const status = ws.trialEndsAt && ws.trialEndsAt > new Date() && !(await hasPaidPlan(db, ws.planId)) ? 'trial' : 'active';
    await db.update(workspaces).set({ status, suspendedReason: null }).where(eq(workspaces.id, ws.id));
    await db.insert(activities).values({ workspaceId: ws.id, type: 'workspace.reactivated', text: 'Agently reactivated this shop', data: {} });
    await audit(db, req, 'tenant.reactivated', { workspaceId: ws.id, targetType: 'workspace', targetId: ws.id, data: { status } });
    return { status };
  });

  /** Moves the trial end later and extends the trial's credits with it. */
  app.post<{ Params: Params }>('/tenants/:workspaceId/extend-trial', async (req, reply) => {
    if (!(await requirePerm(req, reply, 'tenants.manage'))) return reply;
    const ws = await findTenant(db, req.params.workspaceId);
    if (!ws) return reply.code(404).send({ error: 'Tenant not found' });
    const body = await parseBody(extendBody, req.body, reply);
    if (!body) return reply;
    if (ws.status !== 'trial') return reply.code(409).send({ error: 'Only a shop on the free trial can have its trial extended' });
    const base = ws.trialEndsAt && ws.trialEndsAt > new Date() ? ws.trialEndsAt : new Date();
    const trialEndsAt = new Date(base.getTime() + body.days * 864e5);
    await db.transaction(async (tx) => {
      await tx.update(workspaces).set({ trialEndsAt }).where(eq(workspaces.id, ws.id));
      if (ws.trialEndsAt) {
        await tx
          .update(creditGrants)
          .set({ expiresAt: trialEndsAt })
          .where(and(eq(creditGrants.workspaceId, ws.id), eq(creditGrants.reason, 'plan'), eq(creditGrants.expiresAt, ws.trialEndsAt)));
      }
    });
    await audit(db, req, 'tenant.trial_extended', { workspaceId: ws.id, targetType: 'workspace', targetId: ws.id, data: { days: body.days, trialEndsAt } });
    return { trialEndsAt };
  });

  /**
   * Finance changes the plan, until shops can pay online. A paid plan makes
   * the shop active, and this month's credits are topped up to the new plan's
   * allowance at once (never reduced mid-month).
   */
  app.post<{ Params: Params }>('/tenants/:workspaceId/plan', async (req, reply) => {
    if (!(await requirePerm(req, reply, 'billing.manage'))) return reply;
    const ws = await findTenant(db, req.params.workspaceId);
    if (!ws) return reply.code(404).send({ error: 'Tenant not found' });
    const body = await parseBody(planBody, req.body, reply);
    if (!body) return reply;
    const plan = await db.query.plans.findFirst({ where: eq(plans.key, body.planKey) });
    if (!plan) return reply.code(404).send({ error: 'Plan not found' });
    const { start, end } = billingMonth();
    const paid = !plan.trialDays;

    const added = await db.transaction(async (tx) => {
      await tx
        .update(workspaces)
        .set({ planId: plan.id, ...(paid && ws.status !== 'suspended' ? { status: 'active' as const } : {}) })
        .where(eq(workspaces.id, ws.id));
      if (!paid) return 0;
      const [granted] = await tx
        .select({ n: sql<number>`coalesce(sum(${creditGrants.credits}), 0)::int` })
        .from(creditGrants)
        .where(and(eq(creditGrants.workspaceId, ws.id), eq(creditGrants.reason, 'plan'), gte(creditGrants.createdAt, start), eq(creditGrants.expiresAt, end)));
      const missing = plan.limits.aiCreditsPerMonth - (granted?.n ?? 0);
      if (missing > 0) {
        await tx.insert(creditGrants).values({ workspaceId: ws.id, reason: 'plan', credits: missing, expiresAt: end, grantedByPlatformUserId: req.admin.id });
      }
      await tx.insert(activities).values({ workspaceId: ws.id, type: 'plan.changed', text: `Plan changed to ${plan.name}`, data: { plan: plan.key } });
      return Math.max(0, missing);
    });
    await audit(db, req, 'tenant.plan_changed', { workspaceId: ws.id, targetType: 'workspace', targetId: ws.id, data: { from: ws.planId, to: plan.key, creditsAdded: added } });
    return { plan: { key: plan.key, name: plan.name }, creditsAdded: added };
  });

  /** Add (or take back) AI credits for this month, with a note for the audit log. */
  app.post<{ Params: Params }>('/tenants/:workspaceId/credits', async (req, reply) => {
    if (!(await requirePerm(req, reply, 'billing.manage'))) return reply;
    const ws = await findTenant(db, req.params.workspaceId);
    if (!ws) return reply.code(404).send({ error: 'Tenant not found' });
    const body = await parseBody(creditsBody, req.body, reply);
    if (!body) return reply;
    const [grant] = await db
      .insert(creditGrants)
      .values({ workspaceId: ws.id, reason: 'adjustment', credits: body.credits, expiresAt: billingMonth().end, grantedByPlatformUserId: req.admin.id })
      .returning();
    if (body.credits > 0) {
      await db.insert(activities).values({ workspaceId: ws.id, type: 'credits.added', text: `Agently added ${body.credits.toLocaleString('en')} AI credits`, data: { grantId: grant!.id } });
    }
    await audit(db, req, 'tenant.credits_adjusted', { workspaceId: ws.id, targetType: 'credit_grant', targetId: grant!.id, data: { credits: body.credits, note: body.note } });
    return reply.code(201).send({ credits: await creditSummary(db, ws.id) });
  });
};

async function findTenant(db: Db, id: string) {
  if (!isUuid(id)) return undefined;
  return db.query.workspaces.findFirst({ where: eq(workspaces.id, id) });
}

async function hasPaidPlan(db: Db, planId: string | null) {
  if (!planId) return false;
  const plan = await db.query.plans.findFirst({ where: and(eq(plans.id, planId), isNotNull(plans.id)) });
  return !!plan && !plan.trialDays;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
