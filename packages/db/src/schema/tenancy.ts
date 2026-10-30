import { boolean, index, integer, jsonb, numeric, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, updatedAt } from './common.ts';
import { plans } from './platform.ts';

export const localeEnum = pgEnum('locale', ['en', 'bn']);
export const authProviderEnum = pgEnum('auth_provider', ['facebook', 'google', 'credentials']);
export const workspaceStatusEnum = pgEnum('workspace_status', ['trial', 'active', 'past_due', 'suspended']);
export const businessTypeEnum = pgEnum('business_type', ['ecommerce', 'services', 'other']);
export const memberRoleEnum = pgEnum('member_role', ['owner', 'admin', 'agent']);

/** A person who signs in to the shop dashboard. The only table without a workspace. */
export const users = pgTable('users', {
  id: id(),
  name: text().notNull(),
  email: text().unique(),
  passwordHash: text(),
  locale: localeEnum().notNull().default('en'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const authAccounts = pgTable(
  'auth_accounts',
  {
    id: id(),
    userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
    provider: authProviderEnum().notNull(),
    providerAccountId: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex().on(t.provider, t.providerAccountId)],
);

/** One shop. Every other tenant table carries workspace_id. */
export const workspaces = pgTable('workspaces', {
  id: id(),
  name: text().notNull(),
  businessType: businessTypeEnum().notNull().default('ecommerce'),
  status: workspaceStatusEnum().notNull().default('trial'),
  /** Why the workspace is suspended, shown to the owner. */
  suspendedReason: text(),
  planId: uuid().references(() => plans.id),
  trialEndsAt: timestamp({ withTimezone: true }),
  onboardingCompletedAt: timestamp({ withTimezone: true }),
  locale: localeEnum().notNull().default('bn'),
  billingCountry: text().notNull().default('BD'),
  currency: text().notNull().default('BDT'),
  /** Delivery charges, added to every order total. */
  deliveryChargeInsideDhaka: numeric({ precision: 10, scale: 2 }).notNull().default('60'),
  deliveryChargeOutsideDhaka: numeric({ precision: 10, scale: 2 }).notNull().default('120'),
  /** The shop's own wallet numbers; customers pay here and send the transaction id. */
  bkashNumber: text(),
  nagadNumber: text(),
  codEnabled: boolean().notNull().default(true),
  nextOrderNumber: integer().notNull().default(1001),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const memberships = pgTable(
  'memberships',
  {
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: memberRoleEnum().notNull().default('agent'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

/** Recent Activity feed. */
export const activities = pgTable(
  'activities',
  {
    id: id(),
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    type: text().notNull(),
    text: text().notNull(),
    actorUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    /** e.g. { orderId } or { conversationId }, for linking from the feed. */
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.workspaceId, t.createdAt)],
);
