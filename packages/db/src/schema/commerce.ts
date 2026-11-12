import { index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, updatedAt } from './common.ts';
import { channels } from './agent.ts';
import { conversations, customers } from './crm.ts';
import { users, workspaces } from './tenancy.ts';
import { modelCharacters } from './platform.ts';

export interface ProductImage {
  url: string;
  color: string;
}

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
    /** The main photo: always images[0], kept for lists and older readers. */
    imageUrl: text(),
    /**
     * Photos in display order; the first is the main one. `color` is one of the
     * product's colours, or '' for a photo of the whole product.
     */
    images: jsonb().$type<ProductImage[]>().notNull().default([]),
    /** The product's page on the shop's own website, where "Order Now" on a post leads. */
    websiteUrl: text(),
    /** One product video (MP4, MOV or WebM), uploaded or linked. */
    videoUrl: text(),
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

/**
 * A product published as a post on a Facebook page from the dashboard. Comments
 * on the post (webhook post_id) are matched to the product through `postId`,
 * so the bot knows which product a "price?" comment is about.
 */
export const productPosts = pgTable(
  'product_posts',
  {
    id: id(),
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    productId: uuid().notNull().references(() => products.id, { onDelete: 'cascade' }),
    channelId: uuid().notNull().references(() => channels.id, { onDelete: 'cascade' }),
    /** Facebook's post id, "{pageId}_{postId}", as comment webhooks send it. */
    postId: text().notNull(),
    message: text().notNull(),
    photoUrls: jsonb().$type<string[]>().notNull().default([]),
    createdByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex().on(t.channelId, t.postId), index().on(t.productId, t.createdAt)],
);

/** Free-form posts on the shop's Facebook page ("What's on your mind?"): text, photos or one video. */
export const pagePosts = pgTable(
  'page_posts',
  {
    id: id(),
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    channelId: uuid().notNull().references(() => channels.id, { onDelete: 'cascade' }),
    /** Facebook's id: "{pageId}_{postId}" for text and photo posts, the video's id for a video. */
    postId: text().notNull(),
    message: text().notNull().default(''),
    photoUrls: jsonb().$type<string[]>().notNull().default([]),
    videoUrl: text(),
    createdByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex().on(t.channelId, t.postId), index().on(t.workspaceId, t.createdAt)],
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

export const tryOnStatusEnum = pgEnum('try_on_status', ['pending', 'succeeded', 'failed']);

/**
 * One "product image with a model": the shop's garment photo put on one of
 * the platform's model characters by the try-on AI. Runs in the background;
 * the dashboard polls until it succeeds or fails.
 */
export const tryOnImages = pgTable(
  'try_on_images',
  {
    id: id(),
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    characterId: uuid().references(() => modelCharacters.id, { onDelete: 'set null' }),
    /** The model photo used, kept in case the character is later deleted. */
    modelImageUrl: text().notNull(),
    garmentImageUrl: text().notNull(),
    /** auto, tops, bottoms or one-pieces: helps the AI know what to replace. */
    category: text().notNull().default('auto'),
    status: tryOnStatusEnum().notNull().default('pending'),
    resultImageUrl: text(),
    error: text(),
    provider: text().notNull(),
    model: text().notNull(),
    costUsd: numeric({ precision: 12, scale: 6 }).notNull().default('0'),
    createdByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.workspaceId, t.createdAt)],
);

/**
 * "Videos with models": a model photo turned into a short product video,
 * talking from the shop's script or walking and talking.
 */
export const modelVideos = pgTable(
  'model_videos',
  {
    id: id(),
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    /** The photo the video starts from: a generated image or the shop's own upload. */
    sourceImageUrl: text().notNull(),
    /** talk (lip-sync to a voice) or walk (full motion, speech from the prompt). */
    mode: text().notNull().default('talk'),
    script: text(),
    /** A voice recording the shop uploaded instead of a script. */
    audioUrl: text(),
    voice: text(),
    language: text(),
    /** Movement and camera choices, plus the shop's own words. */
    options: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    status: tryOnStatusEnum().notNull().default('pending'),
    resultVideoUrl: text(),
    durationSec: numeric({ precision: 8, scale: 2 }),
    credits: integer().notNull().default(0),
    error: text(),
    provider: text().notNull(),
    model: text().notNull(),
    costUsd: numeric({ precision: 12, scale: 6 }).notNull().default('0'),
    createdByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.workspaceId, t.createdAt)],
);
