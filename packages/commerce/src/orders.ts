import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { activities, orderItems, orders, productVariants, products, workspaces, type Db } from '@agently/db';
import { fromPoisha, toPoisha } from './money.ts';
import { normaliseBdPhone } from './phone.ts';

/** A problem the customer (or the model) can fix; the message is safe to show. */
export class OrderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'OrderError';
    this.code = code;
  }
}

/** Every order call is scoped to one shop and one customer. */
export interface OrderScope {
  workspaceId: string;
  customerId: string;
}

export type Order = typeof orders.$inferSelect;

/**
 * Creates a Confirmed order the moment the customer confirms in chat, and
 * reserves stock. Prices come from the catalog, never from the caller.
 */
export async function createOrder(
  db: Db,
  scope: OrderScope,
  input: { items: { variantId: string; quantity: number }[]; conversationId?: string; source: 'ai' | 'staff' },
): Promise<Order> {
  const wanted = new Map<string, number>();
  for (const item of input.items) {
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      throw new OrderError('bad_quantity', 'Quantity must be a whole number of at least 1.');
    }
    wanted.set(item.variantId, (wanted.get(item.variantId) ?? 0) + item.quantity);
  }
  if (wanted.size === 0) throw new OrderError('no_items', 'The order has no items.');

  return db.transaction(async (tx) => {
    const variants = await tx
      .select({
        id: productVariants.id,
        productId: products.id,
        color: productVariants.color,
        size: productVariants.size,
        variantPrice: productVariants.price,
        title: products.title,
        code: products.code,
        price: products.price,
      })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(
        and(
          eq(productVariants.workspaceId, scope.workspaceId),
          eq(products.status, 'active'),
          inArray(productVariants.id, [...wanted.keys()]),
        ),
      );
    if (variants.length !== wanted.size) {
      throw new OrderError('unknown_item', 'One of the items is not in the catalog.');
    }

    // Reserve stock; the stock >= quantity guard makes concurrent orders safe.
    for (const v of variants) {
      const quantity = wanted.get(v.id)!;
      const [reserved] = await tx
        .update(productVariants)
        .set({ stock: sql`${productVariants.stock} - ${quantity}` })
        .where(and(eq(productVariants.id, v.id), gte(productVariants.stock, quantity)))
        .returning({ id: productVariants.id });
      if (!reserved) {
        const label = [v.title, v.color, v.size].filter(Boolean).join(' ');
        throw new OrderError('out_of_stock', `Not enough stock for ${label}.`);
      }
    }

    const [counter] = await tx
      .update(workspaces)
      .set({ nextOrderNumber: sql`${workspaces.nextOrderNumber} + 1` })
      .where(eq(workspaces.id, scope.workspaceId))
      .returning({ next: workspaces.nextOrderNumber });

    const subtotal = variants.reduce((sum, v) => sum + toPoisha(v.variantPrice ?? v.price) * wanted.get(v.id)!, 0);
    const [order] = await tx
      .insert(orders)
      .values({
        workspaceId: scope.workspaceId,
        customerId: scope.customerId,
        conversationId: input.conversationId,
        number: counter!.next - 1,
        source: input.source,
        status: 'confirmed',
        checkoutStep: 'awaiting_address',
        subtotal: fromPoisha(subtotal),
        total: fromPoisha(subtotal),
      })
      .returning();

    await tx.insert(orderItems).values(
      variants.map((v) => ({
        workspaceId: scope.workspaceId,
        orderId: order!.id,
        productId: v.productId,
        variantId: v.id,
        title: v.title,
        code: v.code,
        color: v.color,
        size: v.size,
        quantity: wanted.get(v.id)!,
        unitPrice: v.variantPrice ?? v.price,
      })),
    );
    await tx.insert(activities).values({
      workspaceId: scope.workspaceId,
      type: 'order.confirmed',
      text: `Order #${order!.number} confirmed in chat`,
      data: { orderId: order!.id },
    });
    return order!;
  });
}

/** Finds one of this customer's orders by its shop-facing number. */
export async function findOrder(db: Db, scope: OrderScope, number: number): Promise<Order> {
  const order = await db.query.orders.findFirst({
    where: and(eq(orders.workspaceId, scope.workspaceId), eq(orders.customerId, scope.customerId), eq(orders.number, number)),
  });
  if (!order) throw new OrderError('not_found', `There is no order #${number} for this customer.`);
  return order;
}

/** The customer's latest order that still needs details, if any. */
export async function findOpenCheckout(db: Db, scope: OrderScope): Promise<Order | undefined> {
  return db.query.orders.findFirst({
    where: and(
      eq(orders.workspaceId, scope.workspaceId),
      eq(orders.customerId, scope.customerId),
      eq(orders.status, 'confirmed'),
      sql`${orders.checkoutStep} <> 'complete'`,
    ),
    orderBy: (o, { desc }) => desc(o.createdAt),
  });
}

/** Address step: saves the delivery details and adds the shop's delivery charge to the total. */
export async function setDeliveryDetails(
  db: Db,
  scope: OrderScope,
  input: { number: number; customerName: string; phone: string; address: string; zone: 'inside_dhaka' | 'outside_dhaka' },
): Promise<Order> {
  const order = await findOrder(db, scope, input.number);
  assertEditable(order);
  const phone = normaliseBdPhone(input.phone);
  if (!phone) throw new OrderError('bad_phone', 'The phone number is not a valid Bangladeshi mobile number (01XXXXXXXXX).');
  const name = input.customerName.trim();
  const address = input.address.trim();
  if (name.length < 2) throw new OrderError('bad_name', 'The name is missing.');
  if (address.length < 8) throw new OrderError('bad_address', 'The address is too short to deliver to.');

  const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, scope.workspaceId) });
  const charge = input.zone === 'inside_dhaka' ? workspace!.deliveryChargeInsideDhaka : workspace!.deliveryChargeOutsideDhaka;

  const [updated] = await db
    .update(orders)
    .set({
      customerName: name,
      phone,
      address,
      deliveryZone: input.zone,
      deliveryCharge: charge,
      total: fromPoisha(toPoisha(order.subtotal) + toPoisha(charge)),
      // Changing the address later keeps a payment step already reached.
      checkoutStep: order.checkoutStep === 'awaiting_address' ? 'awaiting_payment_method' : order.checkoutStep,
    })
    .where(eq(orders.id, order.id))
    .returning();
  return updated!;
}

/** Payment step. COD finishes checkout; bKash and Nagad wait for a transaction id. */
export async function setPaymentMethod(
  db: Db,
  scope: OrderScope,
  input: { number: number; method: 'cod' | 'bkash' | 'nagad' },
): Promise<{ order: Order; payTo?: string }> {
  const order = await findOrder(db, scope, input.number);
  assertEditable(order);
  if (order.checkoutStep === 'awaiting_address') {
    throw new OrderError('address_first', 'Ask for the delivery address before the payment method.');
  }
  if (order.paymentStatus === 'pending_verification' || order.paymentStatus === 'paid') {
    throw new OrderError('already_paid', 'This order already has a payment.');
  }

  const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, scope.workspaceId) });
  const payTo = input.method === 'bkash' ? workspace!.bkashNumber : input.method === 'nagad' ? workspace!.nagadNumber : null;
  if (input.method === 'cod' && !workspace!.codEnabled) {
    throw new OrderError('method_unavailable', 'This shop does not take cash on delivery.');
  }
  if (input.method !== 'cod' && !payTo) {
    throw new OrderError('method_unavailable', `This shop does not take ${input.method === 'bkash' ? 'bKash' : 'Nagad'}.`);
  }

  const [updated] = await db
    .update(orders)
    .set({
      paymentMethod: input.method,
      paymentStatus: input.method === 'cod' ? 'cod_due' : 'unpaid',
      checkoutStep: input.method === 'cod' ? 'complete' : 'awaiting_transaction_id',
    })
    .where(eq(orders.id, order.id))
    .returning();
  return { order: updated!, payTo: payTo ?? undefined };
}

/** The customer sent a bKash/Nagad transaction id; staff check it against the shop's wallet. */
export async function submitTransactionId(
  db: Db,
  scope: OrderScope,
  input: { number: number; transactionId: string; senderNumber?: string },
): Promise<Order> {
  const order = await findOrder(db, scope, input.number);
  assertEditable(order);
  if (order.paymentMethod !== 'bkash' && order.paymentMethod !== 'nagad') {
    throw new OrderError('not_mobile_payment', 'This order is not paid by bKash or Nagad.');
  }
  const trxId = input.transactionId.trim().toUpperCase();
  if (!/^[A-Z0-9]{8,12}$/.test(trxId)) {
    throw new OrderError('bad_transaction_id', 'That does not look like a transaction ID (8 to 12 letters and digits).');
  }
  const senderNumber = input.senderNumber ? normaliseBdPhone(input.senderNumber) : null;

  try {
    const [updated] = await db
      .update(orders)
      .set({
        paymentTransactionId: trxId,
        paymentSenderNumber: senderNumber,
        paymentStatus: 'pending_verification',
        checkoutStep: 'complete',
      })
      .where(eq(orders.id, order.id))
      .returning();
    await db.insert(activities).values({
      workspaceId: scope.workspaceId,
      type: 'order.payment_submitted',
      text: `Order #${order.number}: ${order.paymentMethod === 'bkash' ? 'bKash' : 'Nagad'} transaction ${trxId} to verify`,
      data: { orderId: order.id },
    });
    return updated!;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new OrderError('transaction_reused', 'That transaction ID was already used for another order.');
    }
    throw err;
  }
}

/** Staff action: the payment arrived (paid) or could not be found (rejected). */
export async function verifyPayment(
  db: Db,
  workspaceId: string,
  input: { orderId: string; verifiedByUserId: string; found: boolean },
): Promise<Order> {
  const [updated] = await db
    .update(orders)
    .set({
      paymentStatus: input.found ? 'paid' : 'rejected',
      paymentVerifiedByUserId: input.verifiedByUserId,
      paymentVerifiedAt: new Date(),
    })
    .where(and(eq(orders.id, input.orderId), eq(orders.workspaceId, workspaceId), eq(orders.paymentStatus, 'pending_verification')))
    .returning();
  if (!updated) throw new OrderError('not_pending', 'This order has no payment waiting for verification.');
  return updated;
}

/** Cancels an order that has not shipped yet and puts its stock back. */
export async function cancelOrder(db: Db, workspaceId: string, orderId: string): Promise<Order> {
  return db.transaction(async (tx) => {
    const [cancelled] = await tx
      .update(orders)
      .set({ status: 'cancelled', cancelledAt: new Date() })
      .where(and(eq(orders.id, orderId), eq(orders.workspaceId, workspaceId), eq(orders.status, 'confirmed')))
      .returning();
    if (!cancelled) throw new OrderError('not_cancellable', 'Only confirmed orders that have not shipped can be cancelled.');
    await restock(tx, orderId);
    return cancelled;
  });
}

/** Postgres 23505; drizzle wraps the driver error in `cause`. */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code === '23505' || e.cause?.code === '23505';
}

/** Staff action: handed to a courier. Only a confirmed order with its details complete can ship. */
export async function markShipped(
  db: Db,
  workspaceId: string,
  input: { orderId: string; courier?: string; consignmentId?: string; trackingUrl?: string },
): Promise<Order> {
  const [updated] = await db
    .update(orders)
    .set({
      status: 'shipped',
      shippedAt: new Date(),
      courier: input.courier?.trim() || null,
      consignmentId: input.consignmentId?.trim() || null,
      trackingUrl: input.trackingUrl?.trim() || null,
    })
    .where(
      and(
        eq(orders.id, input.orderId),
        eq(orders.workspaceId, workspaceId),
        eq(orders.status, 'confirmed'),
        eq(orders.checkoutStep, 'complete'),
      ),
    )
    .returning();
  if (!updated) throw new OrderError('not_shippable', 'Only confirmed orders with the address and payment filled in can be shipped.');
  return updated;
}

/** Staff action: the customer received the parcel. Cash on delivery counts as paid. */
export async function markDelivered(db: Db, workspaceId: string, orderId: string): Promise<Order> {
  const [updated] = await db
    .update(orders)
    .set({
      status: 'delivered',
      deliveredAt: new Date(),
      paymentStatus: sql`case when ${orders.paymentStatus} = 'cod_due' then 'paid'::payment_status else ${orders.paymentStatus} end`,
    })
    .where(and(eq(orders.id, orderId), eq(orders.workspaceId, workspaceId), eq(orders.status, 'shipped')))
    .returning();
  if (!updated) throw new OrderError('not_shipped', 'Only shipped orders can be marked delivered.');
  return updated;
}

/** Staff action: the customer refused the parcel. Stock comes back; uncollected cash is no longer due. */
export async function markReturned(db: Db, workspaceId: string, orderId: string): Promise<Order> {
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(orders)
      .set({
        status: 'returned',
        paymentStatus: sql`case when ${orders.paymentStatus} = 'cod_due' then 'unpaid'::payment_status else ${orders.paymentStatus} end`,
      })
      .where(and(eq(orders.id, orderId), eq(orders.workspaceId, workspaceId), eq(orders.status, 'shipped')))
      .returning();
    if (!updated) throw new OrderError('not_shipped', 'Only shipped orders can be marked returned.');
    await restock(tx, orderId);
    return updated;
  });
}

async function restock(tx: Pick<Db, 'select' | 'update'>, orderId: string): Promise<void> {
  const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  for (const item of items) {
    if (!item.variantId) continue;
    await tx
      .update(productVariants)
      .set({ stock: sql`${productVariants.stock} + ${item.quantity}` })
      .where(eq(productVariants.id, item.variantId));
  }
}

function assertEditable(order: Order): void {
  if (order.status !== 'confirmed') {
    throw new OrderError('not_editable', `Order #${order.number} is ${order.status} and can no longer be changed in chat.`);
  }
}
