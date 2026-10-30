import { bigint, boolean, date, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, updatedAt } from './common.ts';
import { workspaces } from './tenancy.ts';

// Tables for the super admin panel: the Agently team, plans, usage and audit.

export const platformRoleEnum = pgEnum('platform_role', ['super_admin', 'support', 'finance']);
export const subscriptionStatusEnum = pgEnum('subscription_status', ['trialing', 'active', 'past_due', 'cancelled']);
export const creditGrantReasonEnum = pgEnum('credit_grant_reason', ['plan', 'topup', 'adjustment']);

/** An Agently team member. Separate from shop users, with its own login and 2FA. */
export const platformUsers = pgTable('platform_users', {
  id: id(),
  name: text().notNull(),
  email: text().notNull().unique(),
  passwordHash: text().notNull(),
  role: platformRoleEnum().notNull(),
  /** Encrypted TOTP secret; required before first sign-in completes. */
  totpSecretEncrypted: text(),
  disabledAt: timestamp({ withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export interface PlanLimits {
  pages: number;
  agents: number;
  /** One credit = one AI reply to a customer. */
  aiCreditsPerMonth: number;
  knowledgeBaseMb: number;
  staffSeats: number;
}

export const plans = pgTable('plans', {
  id: id(),
  key: text().notNull().unique(),
  name: text().notNull(),
  priceBdt: numeric({ precision: 10, scale: 2 }).notNull(),
  priceUsd: numeric({ precision: 10, scale: 2 }).notNull(),
  trialDays: integer(),
  limits: jsonb().$type<PlanLimits>().notNull(),
  active: boolean().notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: id(),
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    planId: uuid().notNull().references(() => plans.id),
    status: subscriptionStatusEnum().notNull(),
    currentPeriodStart: timestamp({ withTimezone: true }).notNull(),
    currentPeriodEnd: timestamp({ withTimezone: true }).notNull(),
    /** sslcommerz, bkash or stripe; Phase 4. */
    gateway: text(),
    gatewaySubscriptionId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.workspaceId)],
);

/** AI credits added to a workspace: the monthly plan allowance, top-ups and manual adjustments. */
export const creditGrants = pgTable(
  'credit_grants',
  {
    id: id(),
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    reason: creditGrantReasonEnum().notNull(),
    credits: integer().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    grantedByPlatformUserId: uuid().references(() => platformUsers.id),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.workspaceId, t.expiresAt)],
);

/** Per workspace, per day, per model. Feeds credits used, the AI usage page and cost reconciliation. */
export const usageRecords = pgTable(
  'usage_records',
  {
    id: id(),
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    day: date().notNull(),
    model: text().notNull(),
    aiReplies: integer().notNull().default(0),
    inputTokens: bigint({ mode: 'number' }).notNull().default(0),
    outputTokens: bigint({ mode: 'number' }).notNull().default(0),
    costUsd: numeric({ precision: 12, scale: 6 }).notNull().default('0'),
    failedCalls: integer().notNull().default(0),
  },
  (t) => [uniqueIndex().on(t.workspaceId, t.day, t.model), index().on(t.day)],
);

/** Every super admin action: viewed a chat, logged in as tenant, changed plan, suspended. */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    platformUserId: uuid().notNull().references(() => platformUsers.id),
    action: text().notNull(),
    workspaceId: uuid().references(() => workspaces.id, { onDelete: 'set null' }),
    targetType: text(),
    targetId: text(),
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    ip: text(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.createdAt), index().on(t.workspaceId, t.createdAt)],
);

/** A flag is global when workspace and plan are both null; the most specific match wins. */
export const featureFlags = pgTable(
  'feature_flags',
  {
    id: id(),
    key: text().notNull(),
    workspaceId: uuid().references(() => workspaces.id, { onDelete: 'cascade' }),
    planId: uuid().references(() => plans.id, { onDelete: 'cascade' }),
    enabled: boolean().notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.key, t.workspaceId, t.planId).nullsNotDistinct()],
);

/** Platform settings: default model, fallback, default prompts. */
export const platformSettings = pgTable('platform_settings', {
  key: text().primaryKey(),
  value: jsonb().notNull(),
  updatedAt: updatedAt(),
});
