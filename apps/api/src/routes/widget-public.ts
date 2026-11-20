import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { agents, channels, conversations, customerIdentities, messages, workspaces, type Db } from '@agently/db';
import type { InboundJob } from '@agently/shared';
import { WIDGET_SCRIPT } from '../widget/script.ts';
import { DEFAULT_COLOR, DEFAULT_WELCOME } from './website.ts';
import type { MetaWebhookDeps } from './meta-webhook.ts';

export interface WidgetPublicDeps {
  db: Db;
  inbound: MetaWebhookDeps['inbound'];
}

export const MAX_WIDGET_TEXT = 1000;
/** Messages a visitor may send per minute, and per IP address (several visitors behind one network). */
const PER_VISITOR = 12;
const PER_IP = 60;

const visitorId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'is not a valid visitor id');
const messageBody = z.object({ visitorId, text: z.string().trim().min(1).max(MAX_WIDGET_TEXT) }).strict();

type KeyParams = { key: string };

/**
 * What the website widget talks to: no session, any site can load it, but chat
 * calls are only answered for pages on the shop's own website (Origin check).
 * Messages go through the same inbound queue as Messenger, so the inbox, the
 * bot, credits and handoff all work as they do there.
 */
export const widgetPublicRoutes: FastifyPluginAsync<WidgetPublicDeps> = async (app, { db, inbound }) => {
  const limiter = rateLimiter();

  app.get('/widget.js', async (_req, reply) =>
    reply.header('content-type', 'application/javascript; charset=utf-8').header('cache-control', 'public, max-age=300').send(WIDGET_SCRIPT),
  );

  // Preflight for the JSON POST. Only the shop's own site gets the CORS headers back.
  app.options<{ Params: KeyParams }>('/widget/:key/*', async (req, reply) => {
    const channel = await liveWidget(db, req.params.key);
    if (!channel || !allowCors(req, reply, channel)) return reply.code(404).send();
    return reply
      .header('access-control-allow-methods', 'GET, POST')
      .header('access-control-allow-headers', 'content-type')
      .header('access-control-max-age', '600')
      .code(204)
      .send();
  });

  /** The widget's look and greeting. */
  app.get<{ Params: KeyParams }>('/widget/:key/config', async (req, reply) => {
    const channel = await liveWidget(db, req.params.key);
    if (!channel || !allowCors(req, reply, channel)) return reply.code(404).send({ error: 'Chat is not available' });
    const [ws, agent] = await Promise.all([
      db.query.workspaces.findFirst({ columns: { name: true, status: true }, where: eq(workspaces.id, channel.workspaceId) }),
      channel.agentId ? db.query.agents.findFirst({ columns: { name: true, status: true }, where: eq(agents.id, channel.agentId) }) : undefined,
    ]);
    return {
      name: ws?.name ?? channel.name,
      agentName: agent?.name ?? null,
      welcomeMessage: channel.meta.welcomeMessage ?? DEFAULT_WELCOME,
      color: channel.meta.color ?? DEFAULT_COLOR,
      // When the bot is off, staff answer from the inbox; the widget says replies may take a while.
      botOnline: agent?.status === 'live' && ws?.status !== 'suspended',
    };
  });

  /** A visitor's message; queued like a Messenger message. */
  app.post<{ Params: KeyParams }>('/widget/:key/messages', async (req, reply) => {
    const channel = await liveWidget(db, req.params.key);
    if (!channel || !allowCors(req, reply, channel)) return reply.code(404).send({ error: 'Chat is not available' });
    const parsed = messageBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      return reply.code(400).send({ error: `${issue.path.join('.') || 'body'}: ${issue.message}` });
    }
    const { visitorId: visitor, text } = parsed.data;
    if (!limiter.take(`v:${channel.id}:${visitor}`, PER_VISITOR) || !limiter.take(`ip:${req.ip}`, PER_IP)) {
      return reply.code(429).send({ error: 'Too many messages. Wait a minute and try again.' });
    }

    const id = randomUUID();
    const job: InboundJob = {
      channel: 'widget',
      channelExternalId: channel.externalId,
      senderExternalId: visitor,
      senderName: 'Website visitor',
      externalId: id,
      kind: 'message',
      text,
      attachments: [],
      timestamp: Date.now(),
    };
    await inbound.add('message', job, {
      jobId: `wg-${id}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 24 * 3600 },
      removeOnFail: { age: 7 * 24 * 3600 },
    });
    return reply.code(202).send({ id, at: new Date(job.timestamp).toISOString() });
  });

  /**
   * The visitor's conversation, oldest first. `after` (an ISO time) returns only
   * newer messages, for polling. The visitor id is the only key to it, so it is
   * random and long, and kept in the visitor's browser.
   */
  app.get<{ Params: KeyParams; Querystring: { visitorId?: string; after?: string } }>('/widget/:key/messages', async (req, reply) => {
    const channel = await liveWidget(db, req.params.key);
    if (!channel || !allowCors(req, reply, channel)) return reply.code(404).send({ error: 'Chat is not available' });
    const visitor = visitorId.safeParse(req.query.visitorId);
    if (!visitor.success) return reply.code(400).send({ error: 'visitorId is not valid' });
    const after = req.query.after ? new Date(req.query.after) : undefined;
    if (after && Number.isNaN(after.getTime())) return reply.code(400).send({ error: 'after must be a date' });

    const identity = await db.query.customerIdentities.findFirst({
      where: and(eq(customerIdentities.channelId, channel.id), eq(customerIdentities.externalId, visitor.data)),
    });
    const conversation = identity
      ? await db.query.conversations.findFirst({
          where: and(eq(conversations.channelId, channel.id), eq(conversations.customerId, identity.customerId)),
        })
      : undefined;
    if (!conversation) return { messages: [], waiting: false };

    const rows = await db
      .select({ id: messages.id, externalId: messages.externalId, direction: messages.direction, sender: messages.sender, text: messages.text, attachments: messages.attachments, createdAt: messages.createdAt })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversation.id),
          eq(messages.kind, 'message'),
          inArray(messages.delivery, ['received', 'sent']),
          after ? gte(messages.createdAt, after) : undefined,
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(100);
    const [last] = await db
      .select({ direction: messages.direction, createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.conversationId, conversation.id))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    return {
      messages: rows.reverse().map((m) => ({
        id: m.id,
        // The id the POST returned, so the widget can match its own message.
        ref: m.direction === 'inbound' ? m.externalId : null,
        from: m.direction === 'inbound' ? 'visitor' : m.sender === 'staff' || m.sender === 'support' ? 'staff' : 'bot',
        text: m.text,
        images: m.attachments.filter((a) => a.type === 'image' && a.url).map((a) => a.url!),
        at: m.createdAt.toISOString(),
      })),
      // The bot is writing: the visitor spoke last, recently, and the bot still has the chat.
      waiting: conversation.mode === 'ai' && last?.direction === 'inbound' && Date.now() - last.createdAt.getTime() < 90_000,
    };
  });
};

function liveWidget(db: Db, key: string) {
  if (!/^wk_[A-Za-z0-9_-]{10,64}$/.test(key)) return undefined;
  return db.query.channels.findFirst({
    where: and(eq(channels.type, 'widget'), eq(channels.externalId, key), eq(channels.status, 'connected')),
    orderBy: asc(channels.createdAt),
  });
}

/**
 * Pages on the shop's website (and its subdomains, with or without www) may
 * call the chat; other sites get no CORS headers and a 404. Requests without an
 * Origin (not from a browser page) are let through: CORS can't guard those anyway.
 */
export function originAllowed(origin: string | undefined, websiteUrl: string | undefined): boolean {
  if (!origin) return true;
  if (!websiteUrl) return false;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  const site = new URL(websiteUrl).hostname.toLowerCase().replace(/^www\./, '');
  return host === site || host.endsWith(`.${site}`);
}

function allowCors(req: FastifyRequest, reply: FastifyReply, channel: typeof channels.$inferSelect): boolean {
  const origin = req.headers.origin;
  if (!originAllowed(origin, channel.meta.websiteUrl)) return false;
  if (origin) reply.header('access-control-allow-origin', origin).header('vary', 'Origin');
  return true;
}

/** A fixed one-minute window per key, in memory: enough to stop one page flooding the bot. */
function rateLimiter() {
  const hits = new Map<string, { n: number; until: number }>();
  return {
    take(key: string, max: number): boolean {
      const now = Date.now();
      if (hits.size > 50_000) for (const [k, v] of hits) if (v.until < now) hits.delete(k);
      const h = hits.get(key);
      if (!h || h.until < now) {
        hits.set(key, { n: 1, until: now + 60_000 });
        return true;
      }
      h.n += 1;
      return h.n <= max;
    },
  };
}
