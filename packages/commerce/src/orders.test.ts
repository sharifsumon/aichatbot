/** Needs DATABASE_URL pointing at a migrated database; skipped otherwise. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { createDb, customers, orderItems, productVariants, products, users, workspaces, type Db } from '@agently/db';
import {
  OrderError,
  cancelOrder,
  createOrder,
  markDelivered,
  markReturned,
  markShipped,
  findOpenCheckout,
  normaliseBdPhone,
  setDeliveryDetails,
  setPaymentMethod,
  submitTransactionId,
  verifyPayment,
} from './index.ts';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL not set';
let db: Db;
let close: () => Promise<void>;

before(() => {
  if (!skip) ({ db, close } = createDb(url!, { max: 4 }));
});
after(async () => {
  if (!skip) await close();
});

async function shop(opts: { bkash?: string; cod?: boolean } = {}) {
  const [ws] = await db
    .insert(workspaces)
    .values({ name: 'Shop', bkashNumber: opts.bkash, codEnabled: opts.cod ?? true, deliveryChargeInsideDhaka: '60', deliveryChargeOutsideDhaka: '120' })
    .returning();
  const [customer] = await db.insert(customers).values({ workspaceId: ws!.id }).returning();
  const [product] = await db.insert(products).values({ workspaceId: ws!.id, title: 'Cotton Shirt', code: 'SH-01', price: '850' }).returning();
  const [blueL] = await db.insert(productVariants).values({ workspaceId: ws!.id, productId: product!.id, color: 'Blue', size: 'L', stock: 3 }).returning();
  const [redXL] = await db
    .insert(productVariants)
    .values({ workspaceId: ws!.id, productId: product!.id, color: 'Red', size: 'XL', stock: 1, price: '900.50' })
    .returning();
  return { scope: { workspaceId: ws!.id, customerId: customer!.id }, blueL: blueL!, redXL: redXL! };
}

const stockOf = async (id: string) => (await db.select().from(productVariants).where(eq(productVariants.id, id)))[0]!.stock;

const rejectsWith = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: unknown) => e instanceof OrderError && e.code === code);

test('normalises Bangladeshi mobile numbers', () => {
  assert.equal(normaliseBdPhone('+880 1712-345678'), '01712345678');
  assert.equal(normaliseBdPhone('০১৭১২৩৪৫৬৭৮'), '01712345678');
  assert.equal(normaliseBdPhone('01212345678'), null);
  assert.equal(normaliseBdPhone('12345'), null);
});

test('COD order: confirm, address, payment; stock reserved and totals from the catalog', { skip }, async () => {
  const { scope, blueL, redXL } = await shop();
  const order = await createOrder(db, scope, {
    source: 'ai',
    items: [
      { variantId: blueL.id, quantity: 1 },
      { variantId: blueL.id, quantity: 1 },
      { variantId: redXL.id, quantity: 1 },
    ],
  });
  assert.equal(order.status, 'confirmed');
  assert.equal(order.number, 1001);
  assert.equal(order.subtotal, '2600.50');
  assert.equal(await stockOf(blueL.id), 1);
  assert.equal(await stockOf(redXL.id), 0);
  assert.equal((await db.select().from(orderItems).where(eq(orderItems.orderId, order.id))).length, 2);
  assert.equal((await findOpenCheckout(db, scope))?.id, order.id);

  await rejectsWith(setPaymentMethod(db, scope, { number: 1001, method: 'cod' }), 'address_first');
  await rejectsWith(
    setDeliveryDetails(db, scope, { number: 1001, customerName: 'Rahim', phone: '123', address: 'House 5, Road 2, Dhanmondi', zone: 'inside_dhaka' }),
    'bad_phone',
  );
  const withAddress = await setDeliveryDetails(db, scope, {
    number: 1001,
    customerName: 'Rahim',
    phone: '+8801712345678',
    address: 'House 5, Road 2, Dhanmondi',
    zone: 'inside_dhaka',
  });
  assert.equal(withAddress.total, '2660.50');
  assert.equal(withAddress.phone, '01712345678');

  const { order: done } = await setPaymentMethod(db, scope, { number: 1001, method: 'cod' });
  assert.equal(done.paymentStatus, 'cod_due');
  assert.equal(done.checkoutStep, 'complete');
  assert.equal(await findOpenCheckout(db, scope), undefined);

  const second = await createOrder(db, scope, { source: 'ai', items: [{ variantId: blueL.id, quantity: 1 }] });
  assert.equal(second.number, 1002);
});

test('out of stock rolls back the whole order', { skip }, async () => {
  const { scope, blueL, redXL } = await shop();
  await rejectsWith(
    createOrder(db, scope, { source: 'ai', items: [{ variantId: blueL.id, quantity: 1 }, { variantId: redXL.id, quantity: 2 }] }),
    'out_of_stock',
  );
  assert.equal(await stockOf(blueL.id), 3);
});

test("a shop cannot order another shop's product or touch its orders", { skip }, async () => {
  const a = await shop();
  const b = await shop();
  await rejectsWith(createOrder(db, a.scope, { source: 'ai', items: [{ variantId: b.blueL.id, quantity: 1 }] }), 'unknown_item');
  const order = await createOrder(db, b.scope, { source: 'ai', items: [{ variantId: b.blueL.id, quantity: 1 }] });
  await rejectsWith(
    setDeliveryDetails(db, a.scope, { number: order.number, customerName: 'X Y', phone: '01712345678', address: 'Somewhere long enough', zone: 'outside_dhaka' }),
    'not_found',
  );
  await rejectsWith(cancelOrder(db, a.scope.workspaceId, order.id), 'not_cancellable');
});

test('bKash: transaction id, staff verification, and no reuse of a transaction id', { skip }, async () => {
  const { scope, blueL } = await shop({ bkash: '01811111111' });
  const details = { customerName: 'Karim', phone: '01912345678', address: 'Village Rd, Sylhet Sadar', zone: 'outside_dhaka' as const };

  const first = await createOrder(db, scope, { source: 'ai', items: [{ variantId: blueL.id, quantity: 1 }] });
  await setDeliveryDetails(db, scope, { number: first.number, ...details });
  await rejectsWith(setPaymentMethod(db, scope, { number: first.number, method: 'nagad' }), 'method_unavailable');
  const { order, payTo } = await setPaymentMethod(db, scope, { number: first.number, method: 'bkash' });
  assert.equal(payTo, '01811111111');
  assert.equal(order.checkoutStep, 'awaiting_transaction_id');
  assert.equal(order.total, '970.00');

  await rejectsWith(submitTransactionId(db, scope, { number: first.number, transactionId: 'abc' }), 'bad_transaction_id');
  const paid = await submitTransactionId(db, scope, { number: first.number, transactionId: '9ab3xk2lq1' });
  assert.equal(paid.paymentStatus, 'pending_verification');
  assert.equal(paid.paymentTransactionId, '9AB3XK2LQ1');

  const second = await createOrder(db, scope, { source: 'ai', items: [{ variantId: blueL.id, quantity: 1 }] });
  await setDeliveryDetails(db, scope, { number: second.number, ...details });
  await setPaymentMethod(db, scope, { number: second.number, method: 'bkash' });
  await rejectsWith(submitTransactionId(db, scope, { number: second.number, transactionId: '9AB3XK2LQ1' }), 'transaction_reused');

  const [staff] = await db.insert(users).values({ name: 'Staff' }).returning();
  const verified = await verifyPayment(db, scope.workspaceId, { orderId: first.id, verifiedByUserId: staff!.id, found: true });
  assert.equal(verified.paymentStatus, 'paid');
});

test('cancel puts stock back', { skip }, async () => {
  const { scope, blueL } = await shop();
  const order = await createOrder(db, scope, { source: 'staff', items: [{ variantId: blueL.id, quantity: 2 }] });
  assert.equal(await stockOf(blueL.id), 1);
  await cancelOrder(db, scope.workspaceId, order.id);
  assert.equal(await stockOf(blueL.id), 3);
  await rejectsWith(cancelOrder(db, scope.workspaceId, order.id), 'not_cancellable');
});

test('ship, deliver (COD becomes paid), and return puts stock back', { skip }, async () => {
  const { scope, blueL } = await shop();
  const details = { customerName: 'Rahim', phone: '01712345678', address: 'House 5, Road 2, Dhanmondi', zone: 'inside_dhaka' as const };

  const a = await createOrder(db, scope, { source: 'ai', items: [{ variantId: blueL.id, quantity: 1 }] });
  await rejectsWith(markShipped(db, scope.workspaceId, { orderId: a.id }), 'not_shippable');
  await setDeliveryDetails(db, scope, { number: a.number, ...details });
  await setPaymentMethod(db, scope, { number: a.number, method: 'cod' });
  const shipped = await markShipped(db, scope.workspaceId, { orderId: a.id, courier: 'Steadfast', consignmentId: 'SF123' });
  assert.equal(shipped.courier, 'Steadfast');
  await rejectsWith(cancelOrder(db, scope.workspaceId, a.id), 'not_cancellable');
  const delivered = await markDelivered(db, scope.workspaceId, a.id);
  assert.equal(delivered.status, 'delivered');
  assert.equal(delivered.paymentStatus, 'paid');

  const b = await createOrder(db, scope, { source: 'ai', items: [{ variantId: blueL.id, quantity: 2 }] });
  await setDeliveryDetails(db, scope, { number: b.number, ...details });
  await setPaymentMethod(db, scope, { number: b.number, method: 'cod' });
  await markShipped(db, scope.workspaceId, { orderId: b.id });
  assert.equal(await stockOf(blueL.id), 0);
  const returned = await markReturned(db, scope.workspaceId, b.id);
  assert.equal(returned.status, 'returned');
  assert.equal(returned.paymentStatus, 'unpaid');
  assert.equal(await stockOf(blueL.id), 2);
  await rejectsWith(markDelivered(db, scope.workspaceId, b.id), 'not_shipped');
});
