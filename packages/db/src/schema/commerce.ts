import { index, integer, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, updatedAt } from './common.ts';
import { conversations, customers } from './crm.ts';
import { users, workspaces } from './tenancy.ts';

export const productStatusEnum = pgEnum('product_status', ['active', 'draft', 'archived']);

/**
 * Confirmed: the customer confirmed the order in chat; stock is reserved.
 * Cancelled is allowed from any status before shipped; stock comes back on
 * cancelled and returned.
 */
export const orderStatusEnum = pgEnum('order_status', ['confirmed', 'shipped', 'delivered', 'returned', 'cancelled']);

/** What the bot still has to collect after the customer confirms. */
export const checkoutStepEnum = pgEnum('checkout_step', [
  'awaiting_address',
  'awaiting_payment_method',
  'awaiting_transaction_id',
  'complete',
]);

export const deliveryZoneEnum = pgEnum('delivery_zone', ['inside_dhaka', 'outside_dhaka']);
export const paymentMethodEnum = pgEnum('payment_method', ['cod', 'bkash', 'nagad']);

/**
 * cod_due: cash on delivery, collected by the courier.
 * pending_verification: customer sent a bKash/Nagad transaction id; staff must check it.
 * rejected: staff could not find the payment.
 */
export const paymentStatusEnum = pgEnum('payment_status', [
  'unpaid',
  'cod_due',
  'pending_verification',
  'paid',
  'rejected',
  'refunded',
]);

export const orderSourceEnum = pgEnum('order_source', ['ai', 'staff']);

export const products = pgTable(
  'products',
  {
    id: id(),
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    title: text().notNull(),
    code: text().notNull(),
    description: text().notNull().default(''),
    price: numeric({ precision: 12, scale: 2 }).notNull(),
    imageUrl: text(),
    status: productStatusEnum().notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex().on(t.workspaceId, t.code)],
);

/** One cell of the color × size stock grid. Use '' when a product has no color or size. */
export const productVariants = pgTable(
  'product_variants',
  {
    id: id(),
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    productId: uuid().notNull().references(() => products.id, { onDelete: 'cascade' }),
    color: text().notNull().default(''),
    size: text().notNull().default(''),
    stock: integer().notNull().default(0),
    /** Overrides the product price when set. */
    price: numeric({ precision: 12, scale: 2 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex().on(t.productId, t.color, t.size), index().on(t.workspaceId)],
);

export const orders = pgTable(
  'orders',
  {
    id: id(),
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Shop-facing number, e.g. #1001. From workspaces.next_order_number. */
    number: integer().notNull(),
    customerId: uuid().notNull().references(() => customers.id),
    conversationId: uuid().references(() => conversations.id, { onDelete: 'set null' }),
    source: orderSourceEnum().notNull(),
    status: orderStatusEnum().notNull().default('confirmed'),
    checkoutStep: checkoutStepEnum().notNull().default('awaiting_address'),

    customerName: text(),
    phone: text(),
    address: text(),
    deliveryZone: deliveryZoneEnum(),

    subtotal: numeric({ precision: 12, scale: 2 }).notNull(),
    deliveryCharge: numeric({ precision: 12, scale: 2 }).notNull().default('0'),
    total: numeric({ precision: 12, scale: 2 }).notNull(),

    paymentMethod: paymentMethodEnum(),
    paymentStatus: paymentStatusEnum().notNull().default('unpaid'),
    /** bKash/Nagad transaction id the customer sent in chat. */
    paymentTransactionId: text(),
    /** The number the customer says they paid from. */
    paymentSenderNumber: text(),
    paymentVerifiedByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    paymentVerifiedAt: timestamp({ withTimezone: true }),

    /** Phase 2: courier booking. */
    courier: text(),
    consignmentId: text(),
    trackingUrl: text(),

    notes: text(),
    confirmedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    shippedAt: timestamp({ withTimezone: true }),
    deliveredAt: timestamp({ withTimezone: true }),
    cancelledAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex().on(t.workspaceId, t.number),
    index().on(t.workspaceId, t.status, t.createdAt),
    index().on(t.workspaceId, t.paymentStatus),
    // A transaction id can pay for only one order in a shop.
    uniqueIndex().on(t.workspaceId, t.paymentMethod, t.paymentTransactionId),
  ],
);

export const orderItems = pgTable(
  'order_items',
  {
    id: id(),
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    orderId: uuid().notNull().references(() => orders.id, { onDelete: 'cascade' }),
    productId: uuid().references(() => products.id, { onDelete: 'set null' }),
    variantId: uuid().references(() => productVariants.id, { onDelete: 'set null' }),
    /** Snapshot at order time, so later catalog edits do not change old orders. */
    title: text().notNull(),
    code: text().notNull(),
    color: text().notNull().default(''),
    size: text().notNull().default(''),
    quantity: integer().notNull(),
    unitPrice: numeric({ precision: 12, scale: 2 }).notNull(),
  },
  (t) => [index().on(t.orderId)],
);
