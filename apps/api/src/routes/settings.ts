import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { normaliseBdPhone } from '@agently/commerce';
import { activities, agents, channels, workspaces, type Db } from '@agently/db';
import { limitsFor } from '@agently/billing';
import { ALL_ROLES, MANAGERS, isUuid, requireRole } from './guard.ts';
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

  // The main (Facebook) bot. Kept for the dashboard and older screens; /agents/:agentId does the same for any bot.
  app.get<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/agent', async (req, reply) => {
    if (!(await requireRole(db, req, reply, ALL_ROLES))) return reply;
    const agent = await mainAgent(db, req.params.workspaceId);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    return { agent: agentOf(agent) };
  });

  app.patch<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/agent', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    const agent = await mainAgent(db, req.params.workspaceId);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    return updateAgent(agent, req.body, req.user.id, reply);
  });

  /** Every bot in the shop (one per channel type), with the channels it answers and the plan's limit. */
  app.get<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/agents', async (req, reply) => {
    if (!(await requireRole(db, req, reply, ALL_ROLES))) return reply;
    const { workspaceId } = req.params;
    const [rows, chans, limits] = await Promise.all([
      db.query.agents.findMany({ where: eq(agents.workspaceId, workspaceId), orderBy: [asc(agents.createdAt), asc(agents.id)] }),
      db
        .select({ id: channels.id, type: channels.type, name: channels.name, status: channels.status, agentId: channels.agentId })
        .from(channels)
        .where(and(eq(channels.workspaceId, workspaceId), ne(channels.status, 'disconnected'))),
      limitsFor(db, workspaceId),
    ]);
    return {
      agents: rows.map((a) => ({
        ...agentOf(a),
        channels: chans.filter((c) => c.agentId === a.id || (!c.agentId && c.type === a.channelType)).map(({ agentId: _a, ...c }) => c),
      })),
      // Channel types with a channel connected but no bot of their own: their chats wait for staff.
      unanswered: [...new Set(chans.filter((c) => !c.agentId && !rows.some((a) => a.channelType === c.type)).map((c) => c.type))],
      limit: limits.agents,
    };
  });

  /** A new bot for WhatsApp or Instagram, starting from the main bot's settings. */
  app.post<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/agents', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    const body = await parseBody(newAgentBody, req.body, reply);
    if (!body) return reply;
    const { workspaceId } = req.params;
    const [existing, limits, main, ws] = await Promise.all([
      db.query.agents.findMany({ columns: { id: true, channelType: true }, where: eq(agents.workspaceId, workspaceId) }),
      limitsFor(db, workspaceId),
      mainAgent(db, workspaceId),
      db.query.workspaces.findFirst({ columns: { name: true }, where: eq(workspaces.id, workspaceId) }),
    ]);
    const label = AGENT_CHANNEL[body.channelType];
    if (existing.some((a) => a.channelType === body.channelType)) {
      return reply.code(409).send({ error: `This shop already has a ${label} agent` });
    }
    if (existing.length >= limits.agents) {
      return reply.code(402).send({
        error: `Your plan allows ${limits.agents} ${limits.agents === 1 ? 'agent' : 'agents'}. Upgrade to add a ${label} agent.`,
        limit: 'agents',
      });
    }

    const agent = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(agents)
        .values({
          workspaceId,
          channelType: body.channelType,
          name: body.name ?? `${ws!.name} ${label} assistant`,
          ...(main && {
            systemInstruction: main.systemInstruction,
            tone: main.tone,
            languages: main.languages,
            handoffEnabled: main.handoffEnabled,
            handoffRules: main.handoffRules,
          }),
          // Comments are a Facebook thing; this bot only answers chats.
          commentReplyMode: 'off',
        })
        .returning();
      // It answers every channel of its type in the shop.
      await tx.update(channels).set({ agentId: created!.id }).where(and(eq(channels.workspaceId, workspaceId), eq(channels.type, body.channelType)));
      await tx.insert(activities).values({
        workspaceId,
        type: 'agent.created',
        text: `${created!.name} added for ${label}`,
        actorUserId: req.user.id,
        data: { agentId: created!.id },
      });
      return created!;
    });
    return reply.code(201).send({ agent: agentOf(agent) });
  });

  app.get<{ Params: AgentParams }>('/workspaces/:workspaceId/agents/:agentId', async (req, reply) => {
    if (!(await requireRole(db, req, reply, ALL_ROLES))) return reply;
    const agent = await agentById(db, req.params);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    return { agent: agentOf(agent) };
  });

  app.patch<{ Params: AgentParams }>('/workspaces/:workspaceId/agents/:agentId', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    const agent = await agentById(db, req.params);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    return updateAgent(agent, req.body, req.user.id, reply);
  });

  /** Removes a WhatsApp or Instagram bot; its chats then wait for staff. The main bot stays. */
  app.delete<{ Params: AgentParams }>('/workspaces/:workspaceId/agents/:agentId', async (req, reply) => {
    if (!(await requireRole(db, req, reply, MANAGERS))) return reply;
    const agent = await agentById(db, req.params);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    if (agent.channelType === 'facebook_page') return reply.code(409).send({ error: 'The main Facebook agent can be paused but not removed' });
    // Channels pointing at it are set back to none by the foreign key.
    await db.delete(agents).where(eq(agents.id, agent.id));
    await db.insert(activities).values({
      workspaceId: agent.workspaceId,
      type: 'agent.deleted',
      text: `${agent.name} removed`,
      actorUserId: req.user.id,
      data: { agentId: agent.id },
    });
    return reply.code(204).send();
  });

  async function updateAgent(agent: typeof agents.$inferSelect, raw: unknown, userId: string, reply: FastifyReply) {
    const body = await parseBody(agentBody, raw, reply);
    if (!body) return reply;

    if (body.status === 'live' && agent.status !== 'live') {
      // Live means answering customers, which needs a channel of its type to answer on.
      const where =
        agent.channelType === 'facebook_page'
          ? and(eq(channels.workspaceId, agent.workspaceId), eq(channels.status, 'connected'), inArray(channels.type, ['facebook_page', 'widget']))
          : and(eq(channels.workspaceId, agent.workspaceId), eq(channels.status, 'connected'), eq(channels.type, agent.channelType));
      const page = await db.query.channels.findFirst({ where });
      if (!page) {
        return reply.code(409).send({
          error:
            agent.channelType === 'facebook_page'
              ? 'Connect a Facebook page or turn on website chat before turning the agent on'
              : `Connect ${agent.channelType === 'whatsapp' ? 'a WhatsApp number' : 'an Instagram account'} in Settings before turning this agent on`,
        });
      }
    }

    const [updated] = await db.update(agents).set(body).where(eq(agents.id, agent.id)).returning();
    if (body.status && body.status !== agent.status) {
      await db.insert(activities).values({
        workspaceId: agent.workspaceId,
        type: `agent.${body.status}`,
        text: body.status === 'live' ? `${agent.name} is live` : body.status === 'paused' ? `${agent.name} is paused` : `${agent.name} is back in setup`,
        actorUserId: userId,
        data: { agentId: agent.id },
      });
    }
    return { agent: agentOf(updated!) };
  }
};

type AgentParams = { workspaceId: string; agentId: string };

const AGENT_CHANNEL = { whatsapp: 'WhatsApp', instagram: 'Instagram' } as const;

const newAgentBody = z
  .object({ channelType: z.enum(['whatsapp', 'instagram']), name: z.string().trim().min(1).max(80).optional() })
  .strict();

/** The shop's main bot: its oldest Facebook one. Facebook pages without a bot of their own use this one too. */
export const mainAgent = (db: Pick<Db, 'query'>, workspaceId: string) =>
  db.query.agents.findFirst({
    where: and(eq(agents.workspaceId, workspaceId), eq(agents.channelType, 'facebook_page')),
    orderBy: [asc(agents.createdAt), asc(agents.id)],
  });

const agentById = (db: Db, p: AgentParams) =>
  isUuid(p.agentId) ? db.query.agents.findFirst({ where: and(eq(agents.id, p.agentId), eq(agents.workspaceId, p.workspaceId)) }) : undefined;

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
