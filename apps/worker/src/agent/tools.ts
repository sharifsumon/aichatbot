import { and, desc, eq, sql } from 'drizzle-orm';
import type { ToolCall, ToolDefinition } from '@agently/ai';
import {
  OrderError,
  createOrder,
  setDeliveryDetails,
  setPaymentMethod,
  submitTransactionId,
  type Order,
  type OrderScope,
} from '@agently/commerce';
import { orders, productVariants, products, type Db } from '@agently/db';
import { searchProducts } from './retrieval.ts';

const orderNumber = { type: 'integer', description: 'The order number, e.g. 1001.' };

export const ORDER_TOOLS: ToolDefinition[] = [
  {
    name: 'find_product',
    description: 'Search the catalog by name, code, colour or size. Returns prices and stock per colour and size.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'create_order',
    description:
      'Create the order. Call ONLY after you repeated the items and prices and the customer clearly confirmed. ' +
      'The order is confirmed at once and stock is reserved.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              code: { type: 'string', description: 'Product code from the catalog.' },
              color: { type: 'string', description: 'Exactly as listed, or empty if the product has none.' },
              size: { type: 'string', description: 'Exactly as listed, or empty if the product has none.' },
              quantity: { type: 'integer', minimum: 1 },
            },
            required: ['code', 'quantity'],
          },
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'set_delivery_details',
    description: "Save the customer's name, mobile number, full address and whether it is inside or outside Dhaka.",
    parameters: {
      type: 'object',
      properties: {
        order_number: orderNumber,
        customer_name: { type: 'string' },
        phone: { type: 'string' },
        address: { type: 'string' },
        zone: { type: 'string', enum: ['inside_dhaka', 'outside_dhaka'] },
      },
      required: ['order_number', 'customer_name', 'phone', 'address', 'zone'],
    },
  },
  {
    name: 'set_payment_method',
    description: 'Save how the customer will pay. For bKash or Nagad, returns the number to send the money to.',
    parameters: {
      type: 'object',
      properties: { order_number: orderNumber, method: { type: 'string', enum: ['cod', 'bkash', 'nagad'] } },
      required: ['order_number', 'method'],
    },
  },
  {
    name: 'submit_transaction_id',
    description: 'Save the bKash or Nagad transaction ID the customer sent. Staff verify it; never say it is verified.',
    parameters: {
      type: 'object',
      properties: {
        order_number: orderNumber,
        transaction_id: { type: 'string' },
        sender_number: { type: 'string', description: 'The number they paid from, if they said.' },
      },
      required: ['order_number', 'transaction_id'],
    },
  },
  {
    name: 'get_order_status',
    description: "The customer's recent orders with status, payment status and total.",
    parameters: { type: 'object', properties: {} },
  },
];

export interface ToolContext {
  db: Db;
  scope: OrderScope;
  conversationId: string;
}

export interface ToolResult {
  content: string;
  /** Products the tool looked at, recorded as the reply's sources. */
  productIds?: string[];
}

/** Runs one tool call. Problems come back to the model as { error } so it can ask the customer. */
export async function runTool(ctx: ToolContext, call: ToolCall): Promise<ToolResult> {
  const a = call.arguments;
  try {
    switch (call.name) {
      case 'find_product': {
        const found = await searchProducts(ctx.db, ctx.scope.workspaceId, String(a.query ?? ''));
        return { content: JSON.stringify({ products: found.map(({ id: _id, ...p }) => p) }), productIds: found.map((p) => p.id) };
      }
      case 'create_order': {
        const items = await resolveItems(ctx, Array.isArray(a.items) ? a.items : []);
        const order = await createOrder(ctx.db, ctx.scope, { items, conversationId: ctx.conversationId, source: 'ai' });
        return { content: JSON.stringify({ ...summary(order), next: 'Ask for name, mobile number, full address, and inside or outside Dhaka.' }) };
      }
      case 'set_delivery_details': {
        const order = await setDeliveryDetails(ctx.db, ctx.scope, {
          number: Number(a.order_number),
          customerName: String(a.customer_name ?? ''),
          phone: String(a.phone ?? ''),
          address: String(a.address ?? ''),
          zone: a.zone === 'inside_dhaka' ? 'inside_dhaka' : 'outside_dhaka',
        });
        return { content: JSON.stringify({ ...summary(order), next: 'Tell the total with delivery and ask how they will pay.' }) };
      }
      case 'set_payment_method': {
        const method = a.method === 'bkash' || a.method === 'nagad' ? a.method : 'cod';
        const { order, payTo } = await setPaymentMethod(ctx.db, ctx.scope, { number: Number(a.order_number), method });
        const next = payTo
          ? `Ask them to send ${order.total} to ${payTo} (${method === 'bkash' ? 'bKash' : 'Nagad'}, Send Money) and reply with the transaction ID.`
          : 'The order is complete. Thank them; the shop will deliver and collect cash on delivery.';
        return { content: JSON.stringify({ ...summary(order), payTo, next }) };
      }
      case 'submit_transaction_id': {
        const order = await submitTransactionId(ctx.db, ctx.scope, {
          number: Number(a.order_number),
          transactionId: String(a.transaction_id ?? ''),
          senderNumber: a.sender_number ? String(a.sender_number) : undefined,
        });
        return { content: JSON.stringify({ ...summary(order), next: 'Thank them; staff will check the payment and confirm.' }) };
      }
      case 'get_order_status': {
        const recent = await ctx.db.query.orders.findMany({
          where: and(eq(orders.workspaceId, ctx.scope.workspaceId), eq(orders.customerId, ctx.scope.customerId)),
          orderBy: desc(orders.createdAt),
          limit: 5,
        });
        return { content: JSON.stringify({ orders: recent.map(summary) }) };
      }
      default:
        return { content: JSON.stringify({ error: `Unknown tool ${call.name}` }) };
    }
  } catch (err) {
    if (err instanceof OrderError) return { content: JSON.stringify({ error: err.message }) };
    throw err;
  }
}

/** Turns { code, color, size } from the model into variant ids, matching case-insensitively. */
async function resolveItems(ctx: ToolContext, raw: unknown[]): Promise<{ variantId: string; quantity: number }[]> {
  const items = [];
  for (const entry of raw) {
    const item = entry as { code?: unknown; color?: unknown; size?: unknown; quantity?: unknown };
    const code = String(item.code ?? '').trim();
    const color = String(item.color ?? '').trim();
    const size = String(item.size ?? '').trim();
    const [variant] = await ctx.db
      .select({ id: productVariants.id })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(
        and(
          eq(products.workspaceId, ctx.scope.workspaceId),
          sql`lower(${products.code}) = lower(${code})`,
          sql`lower(${productVariants.color}) = lower(${color})`,
          sql`lower(${productVariants.size}) = lower(${size})`,
        ),
      )
      .limit(1);
    if (!variant) {
      const label = [code, color, size].filter(Boolean).join(' ');
      throw new OrderError('unknown_item', `${label} is not in the catalog. Check the code, colour and size.`);
    }
    items.push({ variantId: variant.id, quantity: Number(item.quantity) });
  }
  return items;
}

function summary(o: Order) {
  return {
    order_number: o.number,
    status: o.status,
    checkout_step: o.checkoutStep,
    subtotal: o.subtotal,
    delivery_charge: o.deliveryCharge,
    total: o.total,
    payment_method: o.paymentMethod,
    payment_status: o.paymentStatus,
  };
}
