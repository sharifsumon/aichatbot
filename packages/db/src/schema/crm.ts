import { boolean, index, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, updatedAt } from './common.ts';
import { channels } from './agent.ts';
import { users, workspaces } from './tenancy.ts';

export const conversationModeEnum = pgEnum('conversation_mode', ['ai', 'human']);
export const conversationStatusEnum = pgEnum('conversation_status', ['open', 'closed']);
export const messageDirectionEnum = pgEnum('message_direction', ['inbound', 'outbound']);
export const messageKindEnum = pgEnum('message_kind', ['message', 'comment', 'comment_reply', 'private_reply']);
export const messageSenderEnum = pgEnum('message_sender', ['customer', 'ai', 'staff', 'support', 'system']);
export const messageDeliveryEnum = pgEnum('message_delivery', ['received', 'pending', 'sent', 'failed']);
export const leadStatusEnum = pgEnum('lead_status', ['new', 'contacted', 'won', 'lost']);

/** One person buying from one shop. Matched across channels by phone where possible. */
export const customers = pgTable(
  'customers',
  {
    id: id(),
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text(),
    phone: text(),
    address: text(),
    notes: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.workspaceId, t.phone)],
);

/** How a customer is known on a channel: Messenger PSID, WhatsApp number, etc. */
export const customerIdentities = pgTable(
  'customer_identities',
  {
    id: id(),
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    customerId: uuid().notNull().references(() => customers.id, { onDelete: 'cascade' }),
    channelId: uuid().notNull().references(() => channels.id, { onDelete: 'cascade' }),
    externalId: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex().on(t.channelId, t.externalId)],
);

/** Inbox row. In human mode the AI does not reply. */
export const conversations = pgTable(
  'conversations',
  {
    id: id(),
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    channelId: uuid().notNull().references(() => channels.id, { onDelete: 'cascade' }),
    customerId: uuid().notNull().references(() => customers.id, { onDelete: 'cascade' }),
    mode: conversationModeEnum().notNull().default('ai'),
    status: conversationStatusEnum().notNull().default('open'),
    assignedUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    handoffReason: text(),
    /** Flagged for review by staff or Agently support. */
    flagged: boolean().notNull().default(false),
    lastMessageAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Start of Meta's 24-hour reply window. */
    lastCustomerMessageAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex().on(t.channelId, t.customerId),
    index().on(t.workspaceId, t.lastMessageAt),
  ],
);

export interface MessageMeta {
  postId?: string;
  commentId?: string;
  /** On AI replies: the customer message this answers. */
  replyToMessageId?: string;
  /** Knowledge chunks and products the AI used, shown to staff and support. */
  sources?: { type: 'chunk' | 'product'; id: string }[];
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
}

export const messages = pgTable(
  'messages',
  {
    id: id(),
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    conversationId: uuid().notNull().references(() => conversations.id, { onDelete: 'cascade' }),
    channelId: uuid().notNull().references(() => channels.id, { onDelete: 'cascade' }),
    direction: messageDirectionEnum().notNull(),
    kind: messageKindEnum().notNull().default('message'),
    sender: messageSenderEnum().notNull(),
    senderUserId: uuid(),
    text: text().notNull().default(''),
    attachments: jsonb().$type<{ type: string; url?: string }[]>().notNull().default([]),
    /** Meta's message or comment id. Unique per channel so webhook retries are dropped. */
    externalId: text(),
    delivery: messageDeliveryEnum().notNull(),
    meta: jsonb().$type<MessageMeta>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex().on(t.channelId, t.externalId),
    index().on(t.conversationId, t.createdAt),
    index().on(t.workspaceId, t.createdAt),
  ],
);

export const leads = pgTable(
  'leads',
  {
    id: id(),
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    customerId: uuid().notNull().references(() => customers.id, { onDelete: 'cascade' }),
    sourceChannelId: uuid().references(() => channels.id, { onDelete: 'set null' }),
    status: leadStatusEnum().notNull().default('new'),
    reason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex().on(t.workspaceId, t.customerId), index().on(t.workspaceId, t.status)],
);
