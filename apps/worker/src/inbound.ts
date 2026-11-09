import { and, eq } from 'drizzle-orm';
import { channels, conversations, customerIdentities, customers, messages, products, type Db, type MessageMeta } from '@agently/db';
import type { InboundJob } from '@agently/shared';
import type { WorkerDeps } from './deps.ts';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Saves a customer message or comment to the inbox, then queues a reply.
 * Saving always happens, even when the bot will stay quiet (human mode,
 * no credits, suspended shop), so staff see every message.
 */
export async function handleInbound(deps: WorkerDeps, job: InboundJob): Promise<'saved' | 'duplicate' | 'unknown_channel'> {
  const { db, log } = deps;
  const channel = await db.query.channels.findFirst({
    where: and(eq(channels.type, job.channel), eq(channels.externalId, job.channelExternalId)),
  });
  if (!channel || channel.status === 'disconnected') {
    log.warn({ pageId: job.channelExternalId }, 'Message for a page that is not connected');
    return 'unknown_channel';
  }

  const at = new Date(job.timestamp);
  let text = job.text;
  let meta: MessageMeta = job.postId ? { postId: job.postId, commentId: job.externalId } : {};
  if (job.referral) {
    const opened = await fromReferral(db, channel.workspaceId, job.referral.ref);
    meta = { referral: { ref: job.referral.ref, ...(opened && { productId: opened.productId, intent: opened.intent }) } };
    text = opened?.text ?? (text || 'Hi');
  }
  const saved = await db.transaction(async (tx) => {
    const customerId = await findOrCreateCustomer(tx, channel, job);
    const [conversation] = await tx
      .insert(conversations)
      .values({
        workspaceId: channel.workspaceId,
        channelId: channel.id,
        customerId,
        lastMessageAt: at,
        lastCustomerMessageAt: at,
      })
      .onConflictDoUpdate({
        target: [conversations.channelId, conversations.customerId],
        set: { lastMessageAt: at, lastCustomerMessageAt: at, status: 'open' },
      })
      .returning({ id: conversations.id });

    const [message] = await tx
      .insert(messages)
      .values({
        workspaceId: channel.workspaceId,
        conversationId: conversation!.id,
        channelId: channel.id,
        direction: 'inbound',
        kind: job.kind,
        sender: 'customer',
        text,
        attachments: job.attachments,
        externalId: job.externalId,
        delivery: 'received',
        meta,
        createdAt: at,
      })
      .onConflictDoNothing({ target: [messages.channelId, messages.externalId] })
      .returning({ id: messages.id });
    return message;
  });

  if (!saved) return 'duplicate';
  await deps.enqueueReply({ workspaceId: channel.workspaceId, messageId: saved.id });
  return 'saved';
}

async function findOrCreateCustomer(
  tx: Tx,
  channel: { id: string; workspaceId: string },
  job: InboundJob,
): Promise<string> {
  const identityWhere = and(
    eq(customerIdentities.channelId, channel.id),
    eq(customerIdentities.externalId, job.senderExternalId),
  );
  const existing = await tx.query.customerIdentities.findFirst({ where: identityWhere });
  if (existing) return existing.customerId;

  const [customer] = await tx
    .insert(customers)
    .values({ workspaceId: channel.workspaceId, name: job.senderName })
    .returning({ id: customers.id });
  const [identity] = await tx
    .insert(customerIdentities)
    .values({
      workspaceId: channel.workspaceId,
      customerId: customer!.id,
      channelId: channel.id,
      externalId: job.senderExternalId,
    })
    .onConflictDoNothing()
    .returning();
  if (identity) return identity.customerId;

  // Another message from the same new customer got there first.
  await tx.delete(customers).where(eq(customers.id, customer!.id));
  const winner = await tx.query.customerIdentities.findFirst({ where: identityWhere });
  return winner!.customerId;
}

/**
 * Post links open Messenger with ref=product_<id> or ref=order_<id> (see the
 * API's messengerLink). What the customer meant by opening one, written as
 * their first message, so the inbox shows it and the bot answers it.
 */
async function fromReferral(db: Db, workspaceId: string, ref: string) {
  const m = /^(product|order)_([0-9a-f-]{36})$/i.exec(ref);
  if (!m) return undefined;
  const intent = m[1]!.toLowerCase() as 'product' | 'order';
  const product = await db.query.products.findFirst({
    columns: { id: true, title: true, code: true },
    where: and(eq(products.id, m[2]!.toLowerCase()), eq(products.workspaceId, workspaceId)),
  });
  if (!product) return undefined;
  const name = `${product.title} (code ${product.code})`;
  return {
    productId: product.id,
    intent,
    text: intent === 'order' ? `I want to order ${name}.` : `I'm interested in ${name}.`,
  };
}
