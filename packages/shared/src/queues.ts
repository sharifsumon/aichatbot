/** Queue names shared by the API (producer) and the worker (consumer). */
export const QUEUES = {
  /** One job per incoming Messenger message or page comment. */
  inbound: 'inbound',
  /** One job per customer message that may need an AI reply. Retries on its own. */
  reply: 'reply',
  /** Knowledge source ingestion: parse, chunk, embed. */
  knowledge: 'knowledge',
} as const;

export type ChannelKind = 'facebook_page';

/** A customer message or comment, normalised from the channel's webhook payload. */
export interface InboundJob {
  channel: ChannelKind;
  /** Page id for Facebook. */
  channelExternalId: string;
  /** Messenger PSID, or the commenter's id for comments. */
  senderExternalId: string;
  senderName?: string;
  /** Message id (mid) or comment id; used to drop Meta's retries. */
  externalId: string;
  kind: 'message' | 'comment';
  text: string;
  attachments: { type: string; url?: string }[];
  /** For comments: the post the comment is on. */
  postId?: string;
  timestamp: number;
}

export interface ReplyJob {
  workspaceId: string;
  /** The inbound message to answer. */
  messageId: string;
}

export interface KnowledgeJob {
  workspaceId: string;
  sourceId: string;
}

/** BullMQ job ids may not contain ':'; this keeps a Meta id safe to use as one. */
export function jobIdFor(prefix: string, externalId: string): string {
  return `${prefix}-${externalId.replace(/[^A-Za-z0-9_.-]/g, '_')}`;
}
