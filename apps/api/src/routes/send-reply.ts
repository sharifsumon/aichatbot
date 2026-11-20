import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { channels, conversations, customerIdentities, messages, type Db } from '@agently/db';
import { GraphApiError, INSTAGRAM_MAX_TEXT, type GraphClient } from '@agently/meta';
import { decryptSecret } from '@agently/shared';

/** Meta lets a business answer a customer for 24 hours after their last message (Messenger, Instagram and WhatsApp alike). */
export const REPLY_WINDOW_MS = 24 * 3600 * 1000;
export const MAX_REPLY = 2000;

export interface SendDeps {
  db: Db;
  graph: Pick<GraphClient, 'sendText' | 'sendWhatsAppText' | 'replyToComment'>;
  encryptionKey: string;
}

const PLATFORM: Record<string, string> = { facebook_page: 'Facebook', instagram: 'Instagram', whatsapp: 'WhatsApp' };
const CHANNEL_WORD: Record<string, string> = { facebook_page: 'page', instagram: 'Instagram account', whatsapp: 'WhatsApp number' };

export function canReply(lastCustomerMessageAt: Date | null, channelType?: string): boolean {
  // Website chat is ours: no platform window, staff can answer whenever.
  if (channelType === 'widget') return true;
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
  /** A specific customer comment to answer; by default the latest thing the customer sent. */
  toComment?: { id: string; externalId: string | null },
): Promise<SendResult> {
  const { db } = deps;
  const text = typeof rawText === 'string' ? rawText.trim() : '';
  if (!text) return { ok: false, status: 400, error: 'The reply is empty' };
  if (text.length > MAX_REPLY) return { ok: false, status: 400, error: `Replies can be at most ${MAX_REPLY} characters` };

  const channel = await db.query.channels.findFirst({ where: eq(channels.id, conversation.channelId) });
  if (channel?.type === 'widget') {
    // The visitor's widget picks the reply up from the inbox; nothing to send anywhere.
    if (channel.status !== 'connected') return { ok: false, status: 409, error: 'Website chat is turned off. Turn it on in Settings to reply.' };
    return { ok: true, message: await saveReply(deps, conversation, channel.id, text, as, randomUUID(), false) };
  }
  if (!channel?.accessTokenEncrypted || channel.status !== 'connected') {
    return { ok: false, status: 409, error: `This ${CHANNEL_WORD[channel?.type ?? 'facebook_page'] ?? 'channel'} is not connected. Reconnect it to reply.` };
  }
  const latestInbound =
    toComment ??
    (await db.query.messages.findFirst({
      where: and(eq(messages.conversationId, conversation.id), eq(messages.direction, 'inbound')),
      orderBy: desc(messages.createdAt),
    }));
  const isComment = !!toComment || (latestInbound as { kind?: string } | undefined)?.kind === 'comment';
  if (isComment && !latestInbound?.externalId) return { ok: false, status: 409, error: 'This comment can no longer be answered' };
  if (!isComment && !canReply(conversation.lastCustomerMessageAt)) {
    return { ok: false, status: 409, error: `${PLATFORM[channel.type] ?? 'Facebook'} only allows replies within 24 hours of the customer's last message.` };
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
      if (!identity) return { ok: false, status: 409, error: `This customer has no ${PLATFORM[channel.type] ?? 'Messenger'} id on this ${CHANNEL_WORD[channel.type] ?? 'channel'}` };
      [externalId] =
        channel.type === 'whatsapp'
          ? await deps.graph.sendWhatsAppText(token, channel.externalId, identity.externalId, text)
          : await deps.graph.sendText(token, identity.externalId, text, channel.type === 'instagram' ? INSTAGRAM_MAX_TEXT : undefined);
    }
  } catch (err) {
    if (err instanceof GraphApiError) {
      if (err.tokenInvalid) {
        await db.update(channels).set({ status: 'token_expired', lastError: err.message }).where(eq(channels.id, channel.id));
      }
      return { ok: false, status: 502, error: `${PLATFORM[channel.type] ?? 'Facebook'} refused the message: ${err.message}` };
    }
    throw err;
  }

  return { ok: true, message: await saveReply(deps, conversation, channel.id, text, as, externalId, isComment, latestInbound?.id) };
}

async function saveReply(
  { db }: SendDeps,
  conversation: { id: string; workspaceId: string },
  channelId: string,
  text: string,
  as: ReplyAs,
  externalId: string | undefined,
  isComment: boolean,
  inboundId?: string,
) {
  const now = new Date();
  const [message] = await db
    .insert(messages)
    .values({
      workspaceId: conversation.workspaceId,
      conversationId: conversation.id,
      channelId,
      direction: 'outbound',
      kind: isComment ? 'comment_reply' : 'message',
      sender: as.sender,
      senderUserId: as.sender === 'staff' ? as.userId : null,
      meta: {
        ...(as.sender === 'support' ? { supportUserId: as.platformUserId } : {}),
        // Ties a public reply to the comment it answers, for the Comments page.
        ...(isComment && inboundId ? { replyToMessageId: inboundId } : {}),
      },
      text,
      externalId,
      delivery: 'sent',
      createdAt: now,
    })
    .returning();
  await db.update(conversations).set({ lastMessageAt: now }).where(eq(conversations.id, conversation.id));
  return message!;
}
