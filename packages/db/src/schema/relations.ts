import { relations } from 'drizzle-orm';
import { agents, channels, knowledgeChunks, knowledgeSources } from './agent.ts';
import { orderItems, orders, productVariants, products } from './commerce.ts';
import { conversations, customerIdentities, customers, leads, messages } from './crm.ts';
import { plans, subscriptions } from './platform.ts';
import { memberships, users, workspaces } from './tenancy.ts';

export const workspacesRelations = relations(workspaces, ({ one, many }) => ({
  plan: one(plans, { fields: [workspaces.planId], references: [plans.id] }),
  memberships: many(memberships),
  agents: many(agents),
  channels: many(channels),
  subscriptions: many(subscriptions),
}));

export const membershipsRelations = relations(memberships, ({ one }) => ({
  workspace: one(workspaces, { fields: [memberships.workspaceId], references: [workspaces.id] }),
  user: one(users, { fields: [memberships.userId], references: [users.id] }),
}));

export const channelsRelations = relations(channels, ({ one }) => ({
  workspace: one(workspaces, { fields: [channels.workspaceId], references: [workspaces.id] }),
  agent: one(agents, { fields: [channels.agentId], references: [agents.id] }),
}));

export const knowledgeSourcesRelations = relations(knowledgeSources, ({ many }) => ({
  chunks: many(knowledgeChunks),
}));

export const knowledgeChunksRelations = relations(knowledgeChunks, ({ one }) => ({
  source: one(knowledgeSources, { fields: [knowledgeChunks.sourceId], references: [knowledgeSources.id] }),
}));

export const customersRelations = relations(customers, ({ many }) => ({
  identities: many(customerIdentities),
  conversations: many(conversations),
  orders: many(orders),
  leads: many(leads),
}));

export const customerIdentitiesRelations = relations(customerIdentities, ({ one }) => ({
  customer: one(customers, { fields: [customerIdentities.customerId], references: [customers.id] }),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  channel: one(channels, { fields: [conversations.channelId], references: [channels.id] }),
  customer: one(customers, { fields: [conversations.customerId], references: [customers.id] }),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, { fields: [messages.conversationId], references: [conversations.id] }),
}));

export const productsRelations = relations(products, ({ many }) => ({
  variants: many(productVariants),
}));

export const productVariantsRelations = relations(productVariants, ({ one }) => ({
  product: one(products, { fields: [productVariants.productId], references: [products.id] }),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  customer: one(customers, { fields: [orders.customerId], references: [customers.id] }),
  conversation: one(conversations, { fields: [orders.conversationId], references: [conversations.id] }),
  items: many(orderItems),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
  variant: one(productVariants, { fields: [orderItems.variantId], references: [productVariants.id] }),
}));

export const leadsRelations = relations(leads, ({ one }) => ({
  customer: one(customers, { fields: [leads.customerId], references: [customers.id] }),
}));
