import { and, asc, eq, ne } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { normaliseBdPhone } from '@agently/commerce';
import { activities, agents, channels, workspaces, type Db } from '@agently/db';
import { ALL_ROLES, MANAGERS, requireRole } from './guard.ts';
import { parseBody } from './validate.ts';

const money = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^\d{1,6}(\.\d{1,2})?$/.test(v), 'must be an amount like 60 or 60.50');

/** A bKash or Nagad number, stored as 01XXXXXXXXX; null or '' turns the method off. */
const wallet = z
  .union([z.string(), z.null()])
  .transform((v, ctx) => {
    if (v === null || v.trim() === '') return null;
    const phone = normaliseBdPhone(v);
    if (!phone) ctx.addIssue({ code: 'custom', message: 'must be a Bangladeshi mobile number like 01712345678' });
    return phone;
  });

const settingsBody = z
  .object({
    name: z.string().trim().min(2).max(80),
    locale: z.enum(['bn', 'en']),
    businessType: z.enum(['ecommerce', 'services', 'other']),
    deliveryChargeInsideDhaka: money,
    deliveryChargeOutsideDhaka: money,
    bkashNumber: wallet,
    nagadNumber: wallet,
    codEnabled: z.boolean(),
  })
  .partial()
  .strict();

const agentBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    tone: z.enum(['friendly', 'professional', 'casual', 'formal']),
    systemInstruction: z.string().trim().max(4000),
    languages: z.array(z.enum(['bn', 'en'])).min(1).max(2),
    handoffEnabled: z.boolean(),
    handoffRules: z.object({
      minConfidence: z.number().min(0).max(1),
      onComplaint: z.boolean(),
      onHumanRequest: z.boolean(),
      keywords: z.array(z.string().trim().min(1).max(60)).max(50),
    }),
    commentReplyMode: z.enum(['off', 'public', 'private', 'public_and_private']),
    status: z.enum(['setup', 'live', 'paused']),
  })
  .partial()
  .strict();

type Ws = typeof workspaces.$inferSelect;

/** Shop settings (payment, delivery) and the AI agent's settings. */
export const settingsRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.get<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/settings', async (req, reply) => {
    if (!(await requireRole(db, req, reply, ALL_ROLES))) return reply;
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, req.params.workspaceId) });
    return { settings: settingsOf(ws!) };
  });

  app.patch<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/settings', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    const body = await parseBody(settingsBody, req.body, reply);
    if (!body) return reply;
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, req.params.workspaceId) });
    const next = { ...ws!, ...body };
    // The bot must always have a way to take payment.
    if (!next.codEnabled && !next.bkashNumber && !next.nagadNumber) {
      return reply.code(400).send({ error: 'Keep at least one payment method: cash on delivery, bKash or Nagad' });
    }
    const [updated] = await db.update(workspaces).set(body).where(eq(workspaces.id, ws!.id)).returning();
    await db.insert(activities).values({
      workspaceId: ws!.id,
      type: 'settings.updated',
      text: 'Shop settings updated',
      actorUserId: req.user.id,
      data: { fields: Object.keys(body) },
    });
    return { settings: settingsOf(updated!) };
  });

  /** The setup checklist is done; the dashboard stops showing it. */
  app.post<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/onboarding/complete', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, req.params.workspaceId) });
    if (!ws!.onboardingCompletedAt) {
      await db.update(workspaces).set({ onboardingCompletedAt: new Date() }).where(eq(workspaces.id, ws!.id));
    }
    return reply.code(204).send();
  });

  app.get<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/agent', async (req, reply) => {
    if (!(await requireRole(db, req, reply, ALL_ROLES))) return reply;
    const agent = await firstAgent(db, req.params.workspaceId);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    return { agent: agentOf(agent) };
  });

  app.patch<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/agent', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    const agent = await firstAgent(db, req.params.workspaceId);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    const body = await parseBody(agentBody, req.body, reply);
    if (!body) return reply;

    if (body.status === 'live' && agent.status !== 'live') {
      // Live means answering customers, which needs a page to answer on.
      const page = await db.query.channels.findFirst({
        where: and(eq(channels.workspaceId, agent.workspaceId), eq(channels.status, 'connected'), ne(channels.type, 'widget')),
      });
      if (!page) return reply.code(409).send({ error: 'Connect a Facebook page before turning the agent on' });
    }

    const [updated] = await db.update(agents).set(body).where(eq(agents.id, agent.id)).returning();
    if (body.status && body.status !== agent.status) {
      await db.insert(activities).values({
        workspaceId: agent.workspaceId,
        type: `agent.${body.status}`,
        text: body.status === 'live' ? `${agent.name} is live` : body.status === 'paused' ? `${agent.name} is paused` : `${agent.name} is back in setup`,
        actorUserId: req.user.id,
        data: { agentId: agent.id },
      });
    }
    return { agent: agentOf(updated!) };
  });
};

const firstAgent = (db: Db, workspaceId: string) =>
  db.query.agents.findFirst({ where: eq(agents.workspaceId, workspaceId), orderBy: asc(agents.createdAt) });

function settingsOf(ws: Ws) {
  return {
    name: ws.name,
    locale: ws.locale,
    businessType: ws.businessType,
    currency: ws.currency,
    deliveryChargeInsideDhaka: ws.deliveryChargeInsideDhaka,
    deliveryChargeOutsideDhaka: ws.deliveryChargeOutsideDhaka,
    bkashNumber: ws.bkashNumber,
    nagadNumber: ws.nagadNumber,
    codEnabled: ws.codEnabled,
    status: ws.status,
    trialEndsAt: ws.trialEndsAt,
    onboardingCompletedAt: ws.onboardingCompletedAt,
  };
}

function agentOf(a: typeof agents.$inferSelect) {
  const { workspaceId: _ws, createdAt: _c, ...rest } = a;
  return rest;
}
