import { and, desc, eq } from 'drizzle-orm';
import { channels, conversations, customerIdentities, messages, type Db } from '@agently/db';
import { GraphApiError, type GraphClient } from '@agently/meta';
import { decryptSecret } from '@agently/shared';

/** Meta lets a page answer a Messenger customer for 24 hours after their last message. */
export const REPLY_WINDOW_MS = 24 * 3600 * 1000;
export const MAX_REPLY = 2000;

export interface SendDeps {
  db: Db;
  graph: Pick<GraphClient, 'sendText' | 'replyToComment'>;
  encryptionKey: string;
}

export function canReply(lastCustomerMessageAt: Date | null): boolean {
  return !!lastCustomerMessageAt && Date.now() - lastCustomerMessageAt.getTime() < REPLY_WINDOW_MS;
}

/** Who is replying: shop staff, or Agently support (labelled as such in the shop's inbox). */
export type ReplyAs = { sender: 'staff'; userId: string } | { sender: 'support'; platformUserId: string };

export type SendResult =
  | { ok: true; message: typeof messages.$inferSelect }
  | { ok: false; status: number; error: string };

/**
 * Sends a human reply in a conversation on its channel: a Messenger message,
 * or a public reply under the latest comment. Checks the page connection and
 * Meta's 24-hour window, and flags an expired page token.
 */
export async function sendHumanReply(
  deps: SendDeps,
  conversation: { id: string; workspaceId: string; channelId: string; customerId: string; lastCustomerMessageAt: Date | null },
  rawText: unknown,
  as: ReplyAs,
): Promise<SendResult> {
  const { db } = deps;
  const text = typeof rawText === 'string' ? rawText.trim() : '';
  if (!text) return { ok: false, status: 400, error: 'The reply is empty' };
  if (text.length > MAX_REPLY) return { ok: false, status: 400, error: `Replies can be at most ${MAX_REPLY} characters` };

  const channel = await db.query.channels.findFirst({ where: eq(channels.id, conversation.channelId) });
  if (!channel?.accessTokenEncrypted || channel.status !== 'connected') {
    return { ok: false, status: 409, error: 'This page is not connected. Reconnect it to reply.' };
  }
  const latestInbound = await db.query.messages.findFirst({
    where: and(eq(messages.conversationId, conversation.id), eq(messages.direction, 'inbound')),
    orderBy: desc(messages.createdAt),
  });
  const isComment = latestInbound?.kind === 'comment';
  if (!isComment && !canReply(conversation.lastCustomerMessageAt)) {
    return { ok: false, status: 409, error: "Facebook only allows replies within 24 hours of the customer's last message." };
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
      if (!identity) return { ok: false, status: 409, error: 'This customer has no Messenger id on this page' };
      [externalId] = await deps.graph.sendText(token, identity.externalId, text);
    }
  } catch (err) {
    if (err instanceof GraphApiError) {
      if (err.tokenInvalid) {
        await db.update(channels).set({ status: 'token_expired', lastError: err.message }).where(eq(channels.id, channel.id));
      }
      return { ok: false, status: 502, error: `Facebook refused the message: ${err.message}` };
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
      sender: as.sender,
      senderUserId: as.sender === 'staff' ? as.userId : null,
      meta: as.sender === 'support' ? { supportUserId: as.platformUserId } : {},
      text,
      externalId,
      delivery: 'sent',
      createdAt: now,
    })
    .returning();
  await db.update(conversations).set({ lastMessageAt: now }).where(eq(conversations.id, conversation.id));
  return { ok: true, message: message! };
}
