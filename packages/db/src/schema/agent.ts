import { boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, vector } from 'drizzle-orm/pg-core';
import { EMBEDDING_DIMENSIONS, createdAt, id, updatedAt } from './common.ts';
import { workspaces } from './tenancy.ts';

export const agentStatusEnum = pgEnum('agent_status', ['setup', 'live', 'paused']);
export const commentReplyModeEnum = pgEnum('comment_reply_mode', ['off', 'public', 'private', 'public_and_private']);
export const channelTypeEnum = pgEnum('channel_type', ['facebook_page', 'instagram', 'whatsapp', 'widget', 'telegram']);
export const channelStatusEnum = pgEnum('channel_status', ['connected', 'token_expired', 'disconnected', 'error']);
export const knowledgeSourceTypeEnum = pgEnum('knowledge_source_type', ['file', 'text', 'qa', 'website', 'sheet']);
export const knowledgeStatusEnum = pgEnum('knowledge_status', ['queued', 'processing', 'ready', 'failed']);

export interface HandoffRules {
  /** Hand off when the model's confidence is below this (0–1). */
  minConfidence: number;
  onComplaint: boolean;
  onHumanRequest: boolean;
  keywords: string[];
}

/** Extra details a channel keeps: the Instagram account's page, the WhatsApp account and number. */
export interface ChannelMeta {
  /** Instagram: the Facebook page the account is linked to; its token answers DMs. */
  pageId?: string;
  pageName?: string;
  /** Instagram: the @username. */
  username?: string;
  /** WhatsApp: the WhatsApp Business Account the number belongs to. */
  wabaId?: string;
  /** WhatsApp: the number as Meta shows it, e.g. "+880 1712-345678". */
  displayPhoneNumber?: string;
  /** Website chat: the shop's site; the widget only answers pages on it. */
  websiteUrl?: string;
  /** Website chat: the knowledge source that crawls the site. */
  knowledgeSourceId?: string;
  /** Website chat: the first thing the widget says, and its colour (#rrggbb). */
  welcomeMessage?: string;
  color?: string;
}

/**
 * A customer-facing bot. Each shop has one per channel type: the main one for
 * Facebook, and optionally its own for WhatsApp and for Instagram.
 */
export const agents = pgTable(
  'agents',
  {
    id: id(),
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    /** The kind of channel this bot answers. Channels without a bot of their own type stay with staff. */
    channelType: channelTypeEnum().notNull().default('facebook_page'),
    systemInstruction: text().notNull().default(''),
    tone: text().notNull().default('friendly'),
    languages: text().array().notNull().default(['bn', 'en']),
    handoffEnabled: boolean().notNull().default(true),
    handoffRules: jsonb()
      .$type<HandoffRules>()
      .notNull()
      .default({ minConfidence: 0.5, onComplaint: true, onHumanRequest: true, keywords: [] }),
    commentReplyMode: commentReplyModeEnum().notNull().default('public_and_private'),
    status: agentStatusEnum().notNull().default('setup'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.workspaceId)],
);

/** A connected Facebook page, WhatsApp number, widget or Telegram bot. */
export const channels = pgTable(
  'channels',
  {
    id: id(),
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    agentId: uuid().references(() => agents.id, { onDelete: 'set null' }),
    type: channelTypeEnum().notNull(),
    /** Page id, phone number id, bot id. Webhooks are routed by this. */
    externalId: text().notNull(),
    name: text().notNull(),
    /** Encrypted with ENCRYPTION_KEY (see @agently/shared encryptSecret). */
    accessTokenEncrypted: text(),
    status: channelStatusEnum().notNull().default('connected'),
    lastError: text(),
    meta: jsonb().$type<ChannelMeta>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // A page can be connected to only one workspace at a time.
  (t) => [uniqueIndex().on(t.type, t.externalId), index().on(t.workspaceId)],
);

export const knowledgeSources = pgTable(
  'knowledge_sources',
  {
    id: id(),
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    agentId: uuid().references(() => agents.id, { onDelete: 'set null' }),
    type: knowledgeSourceTypeEnum().notNull(),
    name: text().notNull(),
    /** Website or Google Sheet URL. */
    url: text(),
    /** Object storage key for uploaded files. */
    fileKey: text(),
    fileSizeBytes: integer(),
    /** Free text, or Q&A pairs as JSON. */
    content: text(),
    status: knowledgeStatusEnum().notNull().default('queued'),
    error: text(),
    lastSyncedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.workspaceId)],
);

export const knowledgeChunks = pgTable(
  'knowledge_chunks',
  {
    id: id(),
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceId: uuid().notNull().references(() => knowledgeSources.id, { onDelete: 'cascade' }),
    content: text().notNull(),
    embedding: vector({ dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    tokenCount: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index().on(t.workspaceId),
    index('knowledge_chunks_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);
