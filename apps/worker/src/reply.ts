import { and, eq, gt, sql } from 'drizzle-orm';
import { AIProviderError, costUsd } from '@agently/ai';
import { activities, agents, channels, conversations, messages, workspaces } from '@agently/db';
import { GraphApiError } from '@agently/meta';
import { decryptSecret, type ReplyJob } from '@agently/shared';
import { generateReply, type ShopContext } from './agent/generate.ts';
import { FALLBACK_REPLY, SENT_TO_INBOX, detectLanguage, type ReplyLanguage } from './agent/language.ts';
import { creditsRemaining, noteCreditWarnings, recordUsage } from '@agently/billing';
import type { WorkerDeps } from './deps.ts';

export type ReplyOutcome =
  | 'sent'
  | 'handed_off'
  | 'fallback'
  | 'skipped_missing'
  | 'skipped_human_mode'
  | 'skipped_newer_message'
  | 'skipped_already_replied'
  | 'skipped_suspended'
  | 'skipped_agent_not_live'
  | 'skipped_comments_off'
  | 'skipped_channel_unavailable'
  | 'skipped_no_credits';

type Outbound = { kind: 'message' | 'comment_reply' | 'private_reply'; text: string; externalId?: string };

/**
 * Decides whether the bot should answer one customer message, and if so
 * answers it. Throws only for errors worth retrying; on the last attempt a
 * failure sends "a team member will reply shortly" and hands off to staff.
 */
export async function handleReply(deps: WorkerDeps, job: ReplyJob, opts: { finalAttempt: boolean }): Promise<ReplyOutcome> {
  const { db, log } = deps;

  const message = await db.query.messages.findFirst({
    where: and(eq(messages.id, job.messageId), eq(messages.workspaceId, job.workspaceId)),
    with: { conversation: true },
  });
  if (!message || (message.kind !== 'message' && message.kind !== 'comment')) return 'skipped_missing';
  const { conversation } = message;
  if (conversation.mode === 'human') return 'skipped_human_mode';

  const [newer, answered] = await Promise.all([
    // Customers often send several short messages in a row. Only the latest
    // one is answered; its reply sees the others in the history.
    message.kind === 'message'
      ? db.query.messages.findFirst({
          columns: { id: true },
          where: and(
            eq(messages.conversationId, conversation.id),
            eq(messages.direction, 'inbound'),
            eq(messages.kind, 'message'),
            gt(messages.createdAt, message.createdAt),
          ),
        })
      : undefined,
    db.query.messages.findFirst({
      columns: { id: true },
      where: and(eq(messages.conversationId, conversation.id), sql`${messages.meta}->>'replyToMessageId' = ${message.id}`),
    }),
  ]);
  if (newer) return 'skipped_newer_message';
  if (answered) return 'skipped_already_replied';

  const [workspace, channel] = await Promise.all([
    db.query.workspaces.findFirst({ where: eq(workspaces.id, job.workspaceId) }),
    db.query.channels.findFirst({ where: eq(channels.id, message.channelId) }),
  ]);
  if (!workspace || workspace.status === 'suspended') return 'skipped_suspended';
  if (!channel?.accessTokenEncrypted || channel.status !== 'connected') return 'skipped_channel_unavailable';

  const agent = await db.query.agents.findFirst({
    where: channel.agentId ? eq(agents.id, channel.agentId) : eq(agents.workspaceId, workspace.id),
  });
  if (!agent || agent.status !== 'live') return 'skipped_agent_not_live';
  if (message.kind === 'comment' && agent.commentReplyMode === 'off') return 'skipped_comments_off';

  // When credits run out the bot goes quiet; the message is already in the inbox for staff.
  if ((await creditsRemaining(db, workspace.id)) <= 0) return 'skipped_no_credits';

  const pageToken = decryptSecret(channel.accessTokenEncrypted, deps.encryptionKey);
  const commentMode = agent.commentReplyMode;
  const send = (text: string, language: ReplyLanguage) =>
    sendReply(deps, { pageToken, pageId: channel.externalId, source: message, commentMode, text, language });

  const shop: ShopContext = {
    shopName: workspace.name,
    agentName: agent.name,
    tone: agent.tone,
    systemInstruction: agent.systemInstruction,
    currency: workspace.currency === 'BDT' ? '৳' : workspace.currency,
    deliveryInsideDhaka: workspace.deliveryChargeInsideDhaka,
    deliveryOutsideDhaka: workspace.deliveryChargeOutsideDhaka,
    paymentMethods: [
      ...(workspace.codEnabled ? ['Cash on delivery (delivery charge included in the total)'] : []),
      ...(workspace.bkashNumber ? [`bKash to ${workspace.bkashNumber}, then send the transaction ID`] : []),
      ...(workspace.nagadNumber ? [`Nagad to ${workspace.nagadNumber}, then send the transaction ID`] : []),
    ],
  };

  let draft;
  try {
    draft = await generateReply(
      { db, ai: deps.ai, warn: (err, msg) => log.warn({ err }, msg) },
      {
        workspaceId: workspace.id,
        customerId: conversation.customerId,
        conversationId: conversation.id,
        customerText: message.text,
        // With public_and_private, the full answer goes privately, so write it as a chat reply.
        kind: message.kind === 'comment' && commentMode === 'public' ? 'comment' : 'message',
        canOrder: message.kind === 'message',
        shop,
      },
    );
  } catch (err) {
    await recordUsage(db, { workspaceId: workspace.id, model: deps.ai.chatModel, aiReplies: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, failed: true });
    const retryable = err instanceof AIProviderError ? err.retryable : true;
    if (retryable && !opts.finalAttempt) throw err;
    log.error({ err, messageId: message.id }, 'AI reply failed; handing off to staff');
    const language = detectLanguage(message.text);
    const sent = await trySend(deps, channel.id, () => send(FALLBACK_REPLY[language], language));
    await saveOutbound(deps, message, sent, { replyToMessageId: message.id, error: (err as Error).message }, 'system');
    await handOff(deps, conversation.id, workspace.id, 'The AI could not answer');
    return 'fallback';
  }

  await recordUsage(db, {
    workspaceId: workspace.id,
    model: draft.model,
    aiReplies: 0,
    inputTokens: draft.usage.inputTokens,
    outputTokens: draft.usage.outputTokens,
    costUsd: costUsd(draft.usage, deps.pricing),
  });

  const text = draft.text || FALLBACK_REPLY[draft.language];
  const sent = await trySend(deps, channel.id, () => send(text, draft.language));
  await saveOutbound(deps, message, sent, {
    replyToMessageId: message.id,
    sources: draft.sources,
    model: draft.model,
    inputTokens: draft.usage.inputTokens,
    outputTokens: draft.usage.outputTokens,
  }, 'ai');
  if (sent.some((s) => s.externalId)) {
    // One credit per AI reply that reached the customer.
    await recordUsage(db, { workspaceId: workspace.id, model: draft.model, aiReplies: 1, inputTokens: 0, outputTokens: 0, costUsd: 0 });
    // Warn the owner at 80% and 100% used; a failure here must not fail the reply.
    await noteCreditWarnings(db, workspace.id).catch((err: unknown) => deps.log.warn({ err }, 'Credit warning failed'));
  }

  if (draft.handoffReason || !draft.text) {
    await handOff(deps, conversation.id, workspace.id, draft.handoffReason ?? 'The AI had no answer');
    return 'handed_off';
  }
  return 'sent';
}

async function sendReply(
  deps: WorkerDeps,
  r: {
    pageToken: string;
    pageId: string;
    /** The inbound message or comment being answered. */
    source: { kind: string; externalId: string | null; conversationId: string };
    commentMode: 'off' | 'public' | 'private' | 'public_and_private';
    text: string;
    language: ReplyLanguage;
  },
): Promise<Outbound[]> {
  const { graph, db } = deps;
  const { source } = r;

  if (source.kind === 'message') {
    const conversation = await db.query.conversations.findFirst({
      where: eq(conversations.id, source.conversationId),
      with: { customer: { with: { identities: true } } },
    });
    const psid = conversation?.customer.identities.find((i) => i.channelId === conversation.channelId)?.externalId;
    if (!psid) throw new Error('Customer has no Messenger id on this page');
    const ids = await graph.sendText(r.pageToken, psid, r.text);
    return [{ kind: 'message', text: r.text, externalId: ids[0] }];
  }

  const commentId = source.externalId!;
  const out: Outbound[] = [];
  if (r.commentMode === 'private' || r.commentMode === 'public_and_private') {
    const id = await graph.privateReply(r.pageToken, r.pageId, commentId, r.text);
    out.push({ kind: 'private_reply', text: r.text, externalId: id });
  }
  if (r.commentMode === 'public' || r.commentMode === 'public_and_private') {
    const publicText = r.commentMode === 'public' ? r.text : SENT_TO_INBOX[r.language];
    const id = await graph.replyToComment(r.pageToken, commentId, publicText);
    out.push({ kind: 'comment_reply', text: publicText, externalId: id });
  }
  return out;
}

/**
 * Meta errors: an expired page token marks the channel so the dashboard can
 * ask the owner to reconnect; rate limits and outages are retried by the job.
 */
async function trySend(deps: WorkerDeps, channelId: string, send: () => Promise<Outbound[]>): Promise<Outbound[]> {
  try {
    return await send();
  } catch (err) {
    if (err instanceof GraphApiError && err.tokenInvalid) {
      await deps.db.update(channels).set({ status: 'token_expired', lastError: err.message }).where(eq(channels.id, channelId));
      deps.log.warn({ channelId }, 'Page token expired');
      return [];
    }
    throw err;
  }
}

async function saveOutbound(
  deps: WorkerDeps,
  inbound: { workspaceId: string; conversationId: string; channelId: string },
  sent: Outbound[],
  meta: Record<string, unknown>,
  sender: 'ai' | 'system',
): Promise<void> {
  if (sent.length === 0) return;
  const now = new Date();
  await deps.db.insert(messages).values(
    sent.map((s) => ({
      workspaceId: inbound.workspaceId,
      conversationId: inbound.conversationId,
      channelId: inbound.channelId,
      direction: 'outbound' as const,
      kind: s.kind,
      sender,
      text: s.text,
      externalId: s.externalId,
      delivery: s.externalId ? ('sent' as const) : ('failed' as const),
      meta,
      createdAt: now,
    })),
  );
  await deps.db.update(conversations).set({ lastMessageAt: now }).where(eq(conversations.id, inbound.conversationId));
}

async function handOff(deps: WorkerDeps, conversationId: string, workspaceId: string, reason: string): Promise<void> {
  await deps.db.update(conversations).set({ mode: 'human', handoffReason: reason }).where(eq(conversations.id, conversationId));
  await deps.db.insert(activities).values({
    workspaceId,
    type: 'conversation.handoff',
    text: reason,
    data: { conversationId },
  });
}
