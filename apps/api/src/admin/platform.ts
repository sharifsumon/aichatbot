import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { auditLogs, featureFlags, plans, platformSessions, platformSettings, platformUsers, workspaces, type Db } from '@agently/db';
import { hashPassword } from '@agently/shared';
import { isUuid, makeCursor, pageLimit, parseCursor } from '../routes/guard.ts';
import { parseBody } from '../routes/validate.ts';
import { audit, requirePerm } from './guard.ts';

const money = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^\d{1,8}(\.\d{1,2})?$/.test(v), 'must be an amount like 990 or 9.99');

const limits = z.object({
  pages: z.number().int().min(0).max(1000),
  agents: z.number().int().min(0).max(1000),
  aiCreditsPerMonth: z.number().int().min(0).max(10_000_000),
  knowledgeBaseMb: z.number().int().min(0).max(1_000_000),
  staffSeats: z.number().int().min(1).max(1000),
});

const planBody = z
  .object({ name: z.string().trim().min(1).max(60), priceBdt: money, priceUsd: money, limits, active: z.boolean() })
  .partial()
  .strict();
const newPlanBody = z
  .object({ key: z.string().trim().regex(/^[a-z0-9-]{2,40}$/, 'must be lowercase letters, digits and dashes'), name: z.string().trim().min(1).max(60), priceBdt: money, priceUsd: money, limits })
  .strict();

const teamBody = z
  .object({ name: z.string().trim().min(1).max(80), email: z.string().trim().toLowerCase().email().max(200), role: z.enum(['super_admin', 'support', 'finance']) })
  .strict();

const flagBody = z
  .object({
    key: z.string().trim().regex(/^[a-z0-9_.-]{2,60}$/),
    enabled: z.boolean(),
    workspaceId: z.string().uuid().nullish(),
    planKey: z.string().trim().min(1).nullish(),
  })
  .strict();

/** Settings the platform reads; anything else is refused so typos don't pile up. */
const SETTINGS = {
  'ai.defaultModel': z.string().trim().min(1).max(200),
  'ai.fallbackModel': z.string().trim().min(1).max(200).nullable(),
  'ai.defaultSystemInstruction': z.string().max(4000),
  'credits.topUp': z.object({ credits: z.number().int().min(1), priceBdt: money, priceUsd: money }),
} as const;

/** Plans, the Agently team, the audit log, platform settings and feature flags. */
export const adminPlatformRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  // Plans: anyone on the team can read them; finance edits.
  app.get('/plans', async () => ({
    plans: await db
      .select({
        id: plans.id,
        key: plans.key,
        name: plans.name,
        priceBdt: plans.priceBdt,
        priceUsd: plans.priceUsd,
        trialDays: plans.trialDays,
        limits: plans.limits,
        active: plans.active,
        tenants: sql<number>`(select count(*)::int from ${workspaces} where ${workspaces.planId} = ${plans.id})`,
      })
      .from(plans)
      .orderBy(asc(plans.priceBdt)),
  }));

  app.post('/plans', async (req, reply) => {
    if (!(await requirePerm(req, reply, 'billing.manage'))) return reply;
    const body = await parseBody(newPlanBody, req.body, reply);
    if (!body) return reply;
    if (await db.query.plans.findFirst({ where: eq(plans.key, body.key) })) return reply.code(409).send({ error: `A plan with the key ${body.key} exists` });
    const [plan] = await db.insert(plans).values(body).returning();
    await audit(db, req, 'plan.created', { targetType: 'plan', targetId: plan!.id, data: body });
    return reply.code(201).send({ plan });
  });

  /** Changes apply to every shop on the plan; credits change from the next month's grant. */
  app.patch<{ Params: { planId: string } }>('/plans/:planId', async (req, reply) => {
    if (!(await requirePerm(req, reply, 'billing.manage'))) return reply;
    if (!isUuid(req.params.planId)) return reply.code(404).send({ error: 'Plan not found' });
    const before = await db.query.plans.findFirst({ where: eq(plans.id, req.params.planId) });
    if (!before) return reply.code(404).send({ error: 'Plan not found' });
    const body = await parseBody(planBody, req.body, reply);
    if (!body) return reply;
    const [plan] = await db.update(plans).set(body).where(eq(plans.id, before.id)).returning();
    await audit(db, req, 'plan.updated', {
      targetType: 'plan',
      targetId: before.id,
      data: { before: { name: before.name, priceBdt: before.priceBdt, priceUsd: before.priceUsd, limits: before.limits, active: before.active }, changes: body },
    });
    return { plan };
  });

  // The Agently team. Super admins only.
  app.get('/team', async (req, reply) => {
    if (!(await requirePerm(req, reply, 'team.manage'))) return reply;
    const team = await db
      .select({
        id: platformUsers.id,
        name: platformUsers.name,
        email: platformUsers.email,
        role: platformUsers.role,
        twoFactor: sql<boolean>`${platformUsers.totpConfirmedAt} is not null`,
        lastLoginAt: platformUsers.lastLoginAt,
        disabledAt: platformUsers.disabledAt,
        createdAt: platformUsers.createdAt,
      })
      .from(platformUsers)
      .orderBy(asc(platformUsers.createdAt));
    return { team };
  });

  /** Adds a team member with a one-time password, shown once. They set up 2FA on first sign-in. */
  app.post('/team', async (req, reply) => {
    if (!(await requirePerm(req, reply, 'team.manage'))) return reply;
    const body = await parseBody(teamBody, req.body, reply);
    if (!body) return reply;
    if (await db.query.platformUsers.findFirst({ where: eq(platformUsers.email, body.email) })) {
      return reply.code(409).send({ error: 'Someone on the team already uses this email' });
    }
    const password = randomBytes(18).toString('base64url');
    const [user] = await db.insert(platformUsers).values({ ...body, passwordHash: await hashPassword(password) }).returning();
    await audit(db, req, 'team.added', { targetType: 'platform_user', targetId: user!.id, data: { email: body.email, role: body.role } });
    return reply.code(201).send({ member: { id: user!.id, name: user!.name, email: user!.email, role: user!.role }, temporaryPassword: password });
  });

  app.patch<{ Params: { userId: string }; Body: { role?: unknown; disabled?: unknown; resetTwoFactor?: unknown } }>('/team/:userId', async (req, reply) => {
    if (!(await requirePerm(req, reply, 'team.manage'))) return reply;
    if (!isUuid(req.params.userId)) return reply.code(404).send({ error: 'Team member not found' });
    const user = await db.query.platformUsers.findFirst({ where: eq(platformUsers.id, req.params.userId) });
    if (!user) return reply.code(404).send({ error: 'Team member not found' });
    const parsed = await parseBody(
      z.object({ role: z.enum(['super_admin', 'support', 'finance']), disabled: z.boolean(), resetTwoFactor: z.literal(true) }).partial().strict(),
      req.body,
      reply,
    );
    if (!parsed) return reply;
    const self = user.id === req.admin.id;
    if (self && (parsed.disabled || (parsed.role && parsed.role !== 'super_admin'))) {
      return reply.code(409).send({ error: "You can't disable yourself or remove your own super admin role" });
    }
    if ((parsed.disabled || (parsed.role && parsed.role !== 'super_admin')) && user.role === 'super_admin') {
      const [others] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(platformUsers)
        .where(and(eq(platformUsers.role, 'super_admin'), isNull(platformUsers.disabledAt), sql`${platformUsers.id} <> ${user.id}`));
      if (!others?.n) return reply.code(409).send({ error: 'Keep at least one active super admin' });
    }

    await db.transaction(async (tx) => {
      await tx
        .update(platformUsers)
        .set({
          ...(parsed.role ? { role: parsed.role } : {}),
          ...(parsed.disabled !== undefined ? { disabledAt: parsed.disabled ? new Date() : null } : {}),
          ...(parsed.resetTwoFactor ? { totpSecretEncrypted: null, totpConfirmedAt: null, lastTotpStep: null } : {}),
        })
        .where(eq(platformUsers.id, user.id));
      // Disabling, a new role or a 2FA reset all sign the person out everywhere.
      await tx.delete(platformSessions).where(eq(platformSessions.platformUserId, user.id));
    });
    await audit(db, req, 'team.updated', { targetType: 'platform_user', targetId: user.id, data: parsed });
    return reply.code(204).send();
  });

  /** Who did what and when; newest first. */
  app.get<{ Querystring: { workspaceId?: string; actorId?: string; action?: string; cursor?: string; limit?: string } }>('/audit', async (req, reply) => {
    if (!(await requirePerm(req, reply, 'audit.read'))) return reply;
    const q = req.query;
    const limit = pageLimit(q.limit);
    const cursor = parseCursor(q.cursor);
    const rows = await db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        actor: { id: platformUsers.id, name: platformUsers.name, email: platformUsers.email },
        workspace: { id: workspaces.id, name: workspaces.name },
        targetType: auditLogs.targetType,
        targetId: auditLogs.targetId,
        data: auditLogs.data,
        ip: auditLogs.ip,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .innerJoin(platformUsers, eq(platformUsers.id, auditLogs.platformUserId))
      .leftJoin(workspaces, eq(workspaces.id, auditLogs.workspaceId))
      .where(
        and(
          q.workspaceId && isUuid(q.workspaceId) ? eq(auditLogs.workspaceId, q.workspaceId) : undefined,
          q.actorId && isUuid(q.actorId) ? eq(auditLogs.platformUserId, q.actorId) : undefined,
          q.action ? eq(auditLogs.action, q.action) : undefined,
          cursor ? or(lt(auditLogs.createdAt, cursor.at), and(eq(auditLogs.createdAt, cursor.at), lt(auditLogs.id, cursor.id))) : undefined,
        ),
      )
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      entries: page.map((e) => ({ ...e, workspace: e.workspace?.id ? e.workspace : null })),
      nextCursor: rows.length > limit && last ? makeCursor(last.createdAt, last.id) : null,
    };
  });

  app.get('/settings', async (req, reply) => {
    if (!(await requirePerm(req, reply, 'settings.manage'))) return reply;
    const rows = await db.select().from(platformSettings);
    return { settings: Object.fromEntries(rows.map((r) => [r.key, r.value])), keys: Object.keys(SETTINGS) };
  });

  app.put<{ Params: { key: string }; Body: { value?: unknown } }>('/settings/:key', async (req, reply) => {
    if (!(await requirePerm(req, reply, 'settings.manage'))) return reply;
    const schema = SETTINGS[req.params.key as keyof typeof SETTINGS];
    if (!schema) return reply.code(404).send({ error: 'Unknown setting' });
    const parsed = schema.safeParse(req.body?.value);
    if (!parsed.success) return reply.code(400).send({ error: `value: ${parsed.error.issues[0]!.message}` });
    const before = await db.query.platformSettings.findFirst({ where: eq(platformSettings.key, req.params.key) });
    await db
      .insert(platformSettings)
      .values({ key: req.params.key, value: parsed.data })
      .onConflictDoUpdate({ target: platformSettings.key, set: { value: parsed.data } });
    await audit(db, req, 'settings.updated', { targetType: 'setting', targetId: req.params.key, data: { before: before?.value ?? null, after: parsed.data } });
    return { key: req.params.key, value: parsed.data };
  });

  app.get('/flags', async (req, reply) => {
    if (!(await requirePerm(req, reply, 'settings.manage'))) return reply;
    const flags = await db
      .select({ id: featureFlags.id, key: featureFlags.key, enabled: featureFlags.enabled, workspaceId: featureFlags.workspaceId, planKey: plans.key })
      .from(featureFlags)
      .leftJoin(plans, eq(plans.id, featureFlags.planId))
      .orderBy(asc(featureFlags.key));
    return { flags };
  });

  /** Sets a flag globally, for a plan, or for one shop. */
  app.put('/flags', async (req, reply) => {
    if (!(await requirePerm(req, reply, 'settings.manage'))) return reply;
    const body = await parseBody(flagBody, req.body, reply);
    if (!body) return reply;
    if (body.workspaceId && body.planKey) return reply.code(400).send({ error: 'Set a flag for a shop or for a plan, not both' });
    const plan = body.planKey ? await db.query.plans.findFirst({ where: eq(plans.key, body.planKey) }) : undefined;
    if (body.planKey && !plan) return reply.code(404).send({ error: 'Plan not found' });
    if (body.workspaceId && !(await db.query.workspaces.findFirst({ where: eq(workspaces.id, body.workspaceId) }))) {
      return reply.code(404).send({ error: 'Tenant not found' });
    }
    const [flag] = await db
      .insert(featureFlags)
      .values({ key: body.key, enabled: body.enabled, workspaceId: body.workspaceId ?? null, planId: plan?.id ?? null })
      .onConflictDoUpdate({ target: [featureFlags.key, featureFlags.workspaceId, featureFlags.planId], set: { enabled: body.enabled } })
      .returning();
    await audit(db, req, 'flag.set', { workspaceId: body.workspaceId ?? null, targetType: 'flag', targetId: body.key, data: { enabled: body.enabled, planKey: body.planKey ?? null } });
    return { flag };
  });
};
