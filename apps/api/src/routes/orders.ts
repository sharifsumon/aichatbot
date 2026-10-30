import { and, desc, eq, ilike, inArray, lt, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  OrderError,
  cancelOrder,
  markDelivered,
  markReturned,
  markShipped,
  verifyPayment,
  type Order,
} from '@agently/commerce';
import { activities, orderItems, orders, type Db } from '@agently/db';
import { ALL_ROLES, isUuid, makeCursor, pageLimit, parseCursor, requireRole } from './guard.ts';

type Params = { workspaceId: string; orderId: string };

const STATUSES = ['confirmed', 'shipped', 'delivered', 'returned', 'cancelled'] as const;
const PAYMENT_STATUSES = ['unpaid', 'cod_due', 'pending_verification', 'paid', 'rejected', 'refunded'] as const;

/** The Orders CRM: list and filter, detail, and the staff actions on an order. */
export const ordersRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.get<{
    Params: { workspaceId: string };
    Querystring: { status?: string; payment?: string; q?: string; cursor?: string; limit?: string };
  }>('/workspaces/:workspaceId/orders', async (req, reply) => {
    if (!(await requireRole(db, req, reply, ALL_ROLES))) return reply;
    const { status, payment, q } = req.query;
    const limit = pageLimit(req.query.limit);
    const cursor = parseCursor(req.query.cursor);
    const statuses = listParam(status, STATUSES);
    const payments = listParam(payment, PAYMENT_STATUSES);
    const search = q?.trim();

    const rows = await db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.workspaceId, req.params.workspaceId),
          statuses.length ? inArray(orders.status, statuses) : undefined,
          payments.length ? inArray(orders.paymentStatus, payments) : undefined,
          search
            ? or(
                /^#?\d+$/.test(search) ? eq(orders.number, Number(search.replace('#', ''))) : undefined,
                ilike(orders.phone, `%${escapeLike(search)}%`),
                ilike(orders.customerName, `%${escapeLike(search)}%`),
                ilike(orders.paymentTransactionId, `%${escapeLike(search)}%`),
              )
            : undefined,
          cursor ? or(lt(orders.createdAt, cursor.at), and(eq(orders.createdAt, cursor.at), lt(orders.id, cursor.id))) : undefined,
        ),
      )
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const items = page.length
      ? await db.select().from(orderItems).where(inArray(orderItems.orderId, page.map((o) => o.id)))
      : [];
    const last = page.at(-1);
    return {
      orders: page.map((o) => ({ ...o, items: items.filter((i) => i.orderId === o.id) })),
      nextCursor: rows.length > limit && last ? makeCursor(last.createdAt, last.id) : null,
    };
  });

  /** Counts per status and per payment status, for the filter tabs and stat cards. */
  app.get<{ Params: { workspaceId: string } }>('/workspaces/:workspaceId/orders/summary', async (req, reply) => {
    if (!(await requireRole(db, req, reply, ALL_ROLES))) return reply;
    const rows = await db
      .select({ status: orders.status, paymentStatus: orders.paymentStatus, count: sql<number>`count(*)::int`, total: sql<string>`coalesce(sum(${orders.total}), 0)` })
      .from(orders)
      .where(eq(orders.workspaceId, req.params.workspaceId))
      .groupBy(orders.status, orders.paymentStatus);
    const byStatus = Object.fromEntries(STATUSES.map((s) => [s, rows.filter((r) => r.status === s).reduce((n, r) => n + r.count, 0)]));
    const byPayment = Object.fromEntries(PAYMENT_STATUSES.map((s) => [s, rows.filter((r) => r.paymentStatus === s).reduce((n, r) => n + r.count, 0)]));
    return { byStatus, byPayment };
  });

  app.get<{ Params: Params }>('/workspaces/:workspaceId/orders/:orderId', async (req, reply) => {
    if (!(await requireRole(db, req, reply, ALL_ROLES))) return reply;
    if (!isUuid(req.params.orderId)) return reply.code(404).send({ error: 'Order not found' });
    const order = await db.query.orders.findFirst({
      where: and(eq(orders.id, req.params.orderId), eq(orders.workspaceId, req.params.workspaceId)),
      with: { items: true, customer: true },
    });
    if (!order) return reply.code(404).send({ error: 'Order not found' });
    return { order };
  });

  /** Runs one staff action and logs it; order rule violations come back as 409 with a readable message. */
  const action = <B>(path: string, run: (workspaceId: string, orderId: string, body: B, userId: string) => Promise<Order>, describe: (o: Order) => string) =>
    app.post<{ Params: Params; Body: B }>(`/workspaces/:workspaceId/orders/:orderId/${path}`, async (req, reply) => {
      if (!(await requireRole(db, req, reply, ALL_ROLES))) return reply;
      if (!isUuid(req.params.orderId)) return reply.code(404).send({ error: 'Order not found' });
      try {
        const order = await run(req.params.workspaceId, req.params.orderId, (req.body ?? {}) as B, req.user.id);
        await db.insert(activities).values({
          workspaceId: req.params.workspaceId,
          type: `order.${path}`,
          text: describe(order),
          actorUserId: req.user.id,
          data: { orderId: order.id },
        });
        return { order };
      } catch (err) {
        return orderError(reply, err);
      }
    });

  action<{ found?: unknown }>(
    'verify-payment',
    (ws, id, body, userId) => verifyPayment(db, ws, { orderId: id, verifiedByUserId: userId, found: body.found === true }),
    (o) => `Order #${o.number}: payment ${o.paymentStatus === 'paid' ? 'verified' : 'not found'}`,
  );
  action('cancel', (ws, id) => cancelOrder(db, ws, id), (o) => `Order #${o.number} cancelled`);
  action<{ courier?: unknown; consignmentId?: unknown; trackingUrl?: unknown }>(
    'ship',
    (ws, id, body) =>
      markShipped(db, ws, {
        orderId: id,
        courier: str(body.courier),
        consignmentId: str(body.consignmentId),
        trackingUrl: safeUrl(str(body.trackingUrl)),
      }),
    (o) => `Order #${o.number} shipped${o.courier ? ` with ${o.courier}` : ''}`,
  );
  action('deliver', (ws, id) => markDelivered(db, ws, id), (o) => `Order #${o.number} delivered`);
  action('return', (ws, id) => markReturned(db, ws, id), (o) => `Order #${o.number} returned`);
};

function orderError(reply: FastifyReply, err: unknown) {
  if (err instanceof OrderError) return reply.code(409).send({ error: err.message, code: err.code });
  throw err;
}

function listParam<T extends string>(raw: string | undefined, allowed: readonly T[]): T[] {
  return (raw ?? '').split(',').filter((v): v is T => (allowed as readonly string[]).includes(v));
}

const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 500) : undefined);
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Tracking links are shown to staff and later sent to customers, so only http(s). */
function safeUrl(v: string | undefined): string | undefined {
  if (!v) return undefined;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}
