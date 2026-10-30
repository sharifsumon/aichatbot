import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { activities, channels, conversations, customerIdentities, customers, messages, type Db } from '@agently/db';
import { GraphApiError, type GraphClient } from '@agently/meta';
import { decryptSecret } from '@agently/shared';
import { ALL_ROLES, isUuid, makeCursor, pageLimit, parseCursor, requireRole } from './guard.ts';

export interface InboxDeps {
  db: Db;
  graph: Pick<GraphClient, 'sendText' | 'replyToComment'>;
  encryptionKey: string;
}

/** Meta lets a page answer a Messenger customer for 24 hours after their last message. */
const REPLY_WINDOW_MS = 24 * 3600 * 1000;
const MAX_REPLY = 2000;

type Params = { workspaceId: string; conversationId: string };

/** The conversations inbox: what the AI said, staff take over, reply, and hand back. */
export const inboxRoutes: FastifyPluginAsync<InboxDeps> = async (app, deps) => {
  const { db } = deps;

  app.get<{ Params: { workspaceId: string }; Querystring: { mode?: string; status?: string; cursor?: string; limit?: string } }>(
    '/workspaces/:workspaceId/conversations',
    async (req, reply) => {
      if (!(await requireRole(db, req, reply, ALL_ROLES))) return reply;
      const { workspaceId } = req.params;
      const limit = pageLimit(req.query.limit);
      const cursor = parseCursor(req.query.cursor);
      const mode = req.query.mode === 'ai' || req.query.mode === 'human' ? req.query.mode : undefined;
      const status = req.query.status === 'closed' ? 'closed' : 'open';

      const rows = await db
        .select({
          id: conversations.id,
          mode: conversations.mode,
          status: conversations.status,
          flagged: conversations.flagged,
          handoffReason: conversations.handoffReason,
          assignedUserId: conversations.assignedUserId,
          lastMessageAt: conversations.lastMessageAt,
          customer: { id: customers.id, name: customers.name, phone: customers.phone },
          channel: { id: channels.id, type: channels.type, name: channels.name },
          preview: sql<string | null>`(select ${messages.text} from ${messages} where ${messages.conversationId} = ${conversations.id} order by ${messages.createdAt} desc limit 1)`,
        })
        .from(conversations)
        .innerJoin(customers, eq(customers.id, conversations.customerId))
        .innerJoin(channels, eq(channels.id, conversations.channelId))
        .where(
          and(
            eq(conversations.workspaceId, workspaceId),
            eq(conversations.status, status),
            mode ? eq(conversations.mode, mode) : undefined,
            cursor
              ? or(
                  lt(conversations.lastMessageAt, cursor.at),
                  and(eq(conversations.lastMessageAt, cursor.at), lt(conversations.id, cursor.id)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return { conversations: page, nextCursor: rows.length > limit && last ? makeCursor(last.lastMessageAt, last.id) : null };
    },
  );

  app.get<{ Params: Params; Querystring: { before?: string; limit?: string } }>(
    '/workspaces/:workspaceId/conversations/:conversationId',
    async (req, reply) => {
      if (!(await requireRole(db, req, reply, ALL_ROLES))) return reply;
      const conversation = await findConversation(db, req.params);
      if (!conversation) return reply.code(404).send({ error: 'Conversation not found' });

      const limit = pageLimit(req.query.limit, 200, 50);
      const before = parseCursor(req.query.before);
      const rows = await db
        .select({
          id: messages.id,
          direction: messages.direction,
          kind: messages.kind,
          sender: messages.sender,
          senderUserId: messages.senderUserId,
          text: messages.text,
          attachments: messages.attachments,
          delivery: messages.delivery,
          meta: messages.meta,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversation.id),
            before ? or(lt(messages.createdAt, before.at), and(eq(messages.createdAt, before.at), lt(messages.id, before.id))) : undefined,
          ),
        )
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      const oldest = page.at(-1);
      return {
        conversation: {
          ...conversation,
          canReply: canReply(conversation.lastCustomerMessageAt),
        },
        // Oldest first, as the chat shows them.
        messages: page.reverse(),
        olderCursor: rows.length > limit && oldest ? makeCursor(oldest.createdAt, oldest.id) : null,
      };
    },
  );

  app.post<{ Params: Params }>('/workspaces/:workspaceId/conversations/:conversationId/takeover', async (req, reply) => {
    if (!(await requireRole(db, req, reply, ALL_ROLES))) return reply;
    const conversation = await findConversation(db, req.params);
    if (!conversation) return reply.code(404).send({ error: 'Conversation not found' });
    await takeOver(db, conversation, req.user.id, 'Taken over by staff');
    return reply.code(204).send();
  });

  app.post<{ Params: Params }>('/workspaces/:workspaceId/conversations/:conversationId/return-to-ai', async (req, reply) => {
    if (!(await requireRole(db, req, reply, ALL_ROLES))) return reply;
    const conversation = await findConversation(db, req.params);
    if (!conversation) return reply.code(404).send({ error: 'Conversation not found' });
    await db
      .update(conversations)
      .set({ mode: 'ai', handoffReason: null, assignedUserId: null })
      .where(eq(conversations.id, conversation.id));
    await db.insert(activities).values({
      workspaceId: conversation.workspaceId,
      type: 'conversation.returned_to_ai',
      text: 'Conversation handed back to the AI',
      actorUserId: req.user.id,
      data: { conversationId: conversation.id },
    });
    return reply.code(204).send();
  });

  /**
   * Staff reply. Replying takes the conversation over, so the AI doesn't talk
   * over staff. A comment conversation gets a public reply under the latest comment.
   */
  app.post<{ Params: Params; Body: { text?: unknown } }>(
    '/workspaces/:workspaceId/conversations/:conversationId/reply',
    async (req, reply) => {
      if (!(await requireRole(db, req, reply, ALL_ROLES))) return reply;
      const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
      if (!text) return reply.code(400).send({ error: 'The reply is empty' });
      if (text.length > MAX_REPLY) return reply.code(400).send({ error: `Replies can be at most ${MAX_REPLY} characters` });

      const conversation = await findConversation(db, req.params);
      if (!conversation) return reply.code(404).send({ error: 'Conversation not found' });
      const channel = await db.query.channels.findFirst({ where: eq(channels.id, conversation.channelId) });
      if (!channel?.accessTokenEncrypted || channel.status !== 'connected') {
        return reply.code(409).send({ error: 'This page is not connected. Reconnect it to reply.' });
      }

      const latestInbound = await db.query.messages.findFirst({
        where: and(eq(messages.conversationId, conversation.id), eq(messages.direction, 'inbound')),
        orderBy: desc(messages.createdAt),
      });
      const isComment = latestInbound?.kind === 'comment';
      if (!isComment && !canReply(conversation.lastCustomerMessageAt)) {
        return reply.code(409).send({ error: "Facebook only allows replies within 24 hours of the customer's last message." });
      }

      const token = decryptSecret(channel.accessTokenEncrypted, deps.encryptionKey);
      let externalId: string | undefined;
      try {
        if (isComment) {
          externalId = await deps.graph.replyToComment(token, latestInbound!.externalId!, text);
        } else {
          const identity = await db.query.customerIdentities.findFirst({
            where: and(eq(customerIdentities.customerId, conversation.customerId), eq(customerIdentities.channelId, channel.id)),
          });
          if (!identity) return reply.code(409).send({ error: 'This customer has no Messenger id on this page' });
          [externalId] = await deps.graph.sendText(token, identity.externalId, text);
        }
      } catch (err) {
        if (err instanceof GraphApiError) {
          if (err.tokenInvalid) {
            await db.update(channels).set({ status: 'token_expired', lastError: err.message }).where(eq(channels.id, channel.id));
          }
          return reply.code(502).send({ error: `Facebook refused the message: ${err.message}` });
        }
        throw err;
      }

      const now = new Date();
      const [message] = await db
        .insert(messages)
        .values({
          workspaceId: conversation.workspaceId,
          conversationId: conversation.id,
          channelId: channel.id,
          direction: 'outbound',
          kind: isComment ? 'comment_reply' : 'message',
          sender: 'staff',
          senderUserId: req.user.id,
          text,
          externalId,
          delivery: 'sent',
          createdAt: now,
        })
        .returning();
      await db.update(conversations).set({ lastMessageAt: now }).where(eq(conversations.id, conversation.id));
      if (conversation.mode !== 'human') await takeOver(db, conversation, req.user.id, 'Staff replied');
      return reply.code(201).send({ message });
    },
  );
};

async function findConversation(db: Db, p: Params) {
  if (!isUuid(p.conversationId)) return undefined;
  const row = await db.query.conversations.findFirst({
    where: and(eq(conversations.id, p.conversationId), eq(conversations.workspaceId, p.workspaceId)),
    with: { customer: true, channel: { columns: { id: true, type: true, name: true, status: true } } },
  });
  return row;
}

async function takeOver(
  db: Db,
  conversation: { id: string; workspaceId: string },
  userId: string,
  reason: string,
): Promise<void> {
  await db
    .update(conversations)
    .set({ mode: 'human', assignedUserId: userId, handoffReason: reason })
    .where(eq(conversations.id, conversation.id));
  await db.insert(activities).values({
    workspaceId: conversation.workspaceId,
    type: 'conversation.taken_over',
    text: reason,
    actorUserId: userId,
    data: { conversationId: conversation.id },
  });
}

function canReply(lastCustomerMessageAt: Date | null): boolean {
  return !!lastCustomerMessageAt && Date.now() - lastCustomerMessageAt.getTime() < REPLY_WINDOW_MS;
}
