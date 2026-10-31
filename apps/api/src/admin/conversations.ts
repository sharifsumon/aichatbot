import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { channels, conversations, customers, knowledgeChunks, knowledgeSources, messages, products, workspaces } from '@agently/db';
import { isUuid, makeCursor, pageLimit, parseCursor } from '../routes/guard.ts';
import { canReply, sendHumanReply, type SendDeps } from '../routes/send-reply.ts';
import { audit, maskAddress, maskPhones, requirePerm } from './guard.ts';

type Params = { conversationId: string };

/**
 * The conversations monitor: every shop's chats in one list. Phone numbers and
 * addresses are masked unless asked for, and every open, reveal and reply is audited.
 */
export const adminConversationRoutes: FastifyPluginAsync<SendDeps> = async (app, deps) => {
  const { db } = deps;

  app.get<{ Querystring: { workspaceId?: string; channel?: string; mode?: string; handedOff?: string; flagged?: string; failed?: string; cursor?: string; limit?: string } }>(
    '/conversations',
    async (req, reply) => {
      if (!(await requirePerm(req, reply, 'conversations'))) return reply;
      const q = req.query;
      const limit = pageLimit(q.limit);
      const cursor = parseCursor(q.cursor);
      const failedReply = sql`exists (select 1 from ${messages} where ${messages.conversationId} = ${conversations.id} and ${messages.delivery} = 'failed')`;
      const rows = await db
        .select({
          id: conversations.id,
          workspace: { id: workspaces.id, name: workspaces.name },
          channel: { type: channels.type, name: channels.name },
          customerName: customers.name,
          mode: conversations.mode,
          status: conversations.status,
          handoffReason: conversations.handoffReason,
          flagged: conversations.flagged,
          lastMessageAt: conversations.lastMessageAt,
          preview: sql<string | null>`(select ${messages.text} from ${messages} where ${messages.conversationId} = ${conversations.id} order by ${messages.createdAt} desc limit 1)`,
          hasFailedReply: sql<boolean>`${failedReply}`,
        })
        .from(conversations)
        .innerJoin(workspaces, eq(workspaces.id, conversations.workspaceId))
        .innerJoin(channels, eq(channels.id, conversations.channelId))
        .innerJoin(customers, eq(customers.id, conversations.customerId))
        .where(
          and(
            q.workspaceId && isUuid(q.workspaceId) ? eq(conversations.workspaceId, q.workspaceId) : undefined,
            q.channel === 'facebook_page' ? eq(channels.type, 'facebook_page') : undefined,
            q.mode === 'ai' || q.mode === 'human' ? eq(conversations.mode, q.mode) : undefined,
            q.handedOff === 'true' ? sql`${conversations.handoffReason} is not null` : undefined,
            q.flagged === 'true' ? eq(conversations.flagged, true) : undefined,
            q.failed === 'true' ? failedReply : undefined,
            cursor ? or(lt(conversations.lastMessageAt, cursor.at), and(eq(conversations.lastMessageAt, cursor.at), lt(conversations.id, cursor.id))) : undefined,
          ),
        )
        .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        conversations: page.map((c) => ({ ...c, preview: c.preview ? maskPhones(c.preview) : c.preview })),
        nextCursor: rows.length > limit && last ? makeCursor(last.lastMessageAt, last.id) : null,
      };
    },
  );

  /** One conversation with its messages and the sources the AI used. `reveal=true` unmasks contact details. */
  app.get<{ Params: Params; Querystring: { reveal?: string } }>('/conversations/:conversationId', async (req, reply) => {
    if (!(await requirePerm(req, reply, 'conversations'))) return reply;
    const conversation = await find(req.params.conversationId);
    if (!conversation) return reply.code(404).send({ error: 'Conversation not found' });
    const reveal = req.query.reveal === 'true';

    const rows = await db.select().from(messages).where(eq(messages.conversationId, conversation.id)).orderBy(desc(messages.createdAt)).limit(200);
    const chunkIds = new Set<string>();
    const productIds = new Set<string>();
    for (const m of rows) for (const s of m.meta.sources ?? []) (s.type === 'chunk' ? chunkIds : productIds).add(s.id);
    const [chunks, productRows] = await Promise.all([
      chunkIds.size
        ? db
            .select({ id: knowledgeChunks.id, content: knowledgeChunks.content, source: knowledgeSources.name })
            .from(knowledgeChunks)
            .innerJoin(knowledgeSources, eq(knowledgeSources.id, knowledgeChunks.sourceId))
            .where(inArray(knowledgeChunks.id, [...chunkIds]))
        : [],
      productIds.size ? db.select({ id: products.id, title: products.title, code: products.code, price: products.price }).from(products).where(inArray(products.id, [...productIds])) : [],
    ]);

    await audit(db, req, reveal ? 'conversation.revealed' : 'conversation.viewed', {
      workspaceId: conversation.workspaceId,
      targetType: 'conversation',
      targetId: conversation.id,
    });
    const mask = (t: string) => (reveal ? t : maskPhones(t));
    const { customer, ...rest } = conversation;
    return {
      conversation: {
        ...rest,
        canReply: canReply(conversation.lastCustomerMessageAt),
        customer: {
          id: customer.id,
          name: customer.name,
          phone: customer.phone && !reveal ? maskPhones(customer.phone) : customer.phone,
          address: reveal ? customer.address : maskAddress(customer.address),
        },
      },
      masked: !reveal,
      messages: rows.reverse().map((m) => ({ ...m, text: mask(m.text) })),
      sources: { chunks: chunks.map((c) => ({ ...c, content: mask(c.content) })), products: productRows },
    };
  });

  /**
   * Reply as Agently support. The shop sees it labelled as support, and the
   * AI stops in this conversation so it doesn't talk over the reply.
   */
  app.post<{ Params: Params; Body: { text?: unknown } }>('/conversations/:conversationId/reply', async (req, reply) => {
    if (!(await requirePerm(req, reply, 'conversations'))) return reply;
    const conversation = await find(req.params.conversationId);
    if (!conversation) return reply.code(404).send({ error: 'Conversation not found' });
    const sent = await sendHumanReply(deps, conversation, req.body?.text, { sender: 'support', platformUserId: req.admin.id });
    if (!sent.ok) return reply.code(sent.status).send({ error: sent.error });
    if (conversation.mode !== 'human') {
      await db.update(conversations).set({ mode: 'human', handoffReason: 'Agently support replied' }).where(eq(conversations.id, conversation.id));
    }
    await audit(db, req, 'conversation.replied', {
      workspaceId: conversation.workspaceId,
      targetType: 'message',
      targetId: sent.message.id,
      data: { conversationId: conversation.id },
    });
    return reply.code(201).send({ message: sent.message });
  });

  /** Flag or unflag for review. */
  app.post<{ Params: Params; Body: { flagged?: unknown } }>('/conversations/:conversationId/flag', async (req, reply) => {
    if (!(await requirePerm(req, reply, 'conversations'))) return reply;
    const conversation = await find(req.params.conversationId);
    if (!conversation) return reply.code(404).send({ error: 'Conversation not found' });
    const flagged = req.body?.flagged !== false;
    await db.update(conversations).set({ flagged }).where(eq(conversations.id, conversation.id));
    await audit(db, req, flagged ? 'conversation.flagged' : 'conversation.unflagged', { workspaceId: conversation.workspaceId, targetType: 'conversation', targetId: conversation.id });
    return reply.code(204).send();
  });

  function find(id: string) {
    if (!isUuid(id)) return Promise.resolve(undefined);
    return db.query.conversations.findFirst({
      where: eq(conversations.id, id),
      with: { customer: true, channel: { columns: { id: true, type: true, name: true, status: true } } },
    });
  }
};
