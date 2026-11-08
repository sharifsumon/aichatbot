/** Order words and colours, shared by Orders and the Inbox. */
import type { Order, OrderStatus, PaymentStatus } from '@/lib/types';

type Tone = 'green' | 'red' | 'amber' | 'blue' | 'violet' | 'brand' | undefined;

export const STATUS: Record<OrderStatus, { label: string; tone: Tone }> = {
  confirmed: { label: 'Confirmed', tone: 'green' },
  shipped: { label: 'Shipped', tone: 'blue' },
  delivered: { label: 'Delivered', tone: 'violet' },
  returned: { label: 'Returned', tone: 'red' },
  cancelled: { label: 'Cancelled', tone: undefined },
};

export const PAYMENT: Record<PaymentStatus, { label: string; tone: Tone }> = {
  unpaid: { label: 'Unpaid', tone: undefined },
  cod_due: { label: 'Cash on delivery', tone: undefined },
  pending_verification: { label: 'Awaiting verification', tone: 'amber' },
  paid: { label: 'Paid', tone: 'green' },
  rejected: { label: 'Payment not found', tone: 'red' },
  refunded: { label: 'Refunded', tone: 'blue' },
};

export const METHOD: Record<NonNullable<Order['paymentMethod']>, string> = { cod: 'COD', bkash: 'bKash', nagad: 'Nagad' };

export const STEP: Record<Order['checkoutStep'], string> = {
  awaiting_address: 'Waiting for the address',
  awaiting_payment_method: 'Waiting for a payment method',
  awaiting_transaction_id: 'Waiting for the transaction ID',
  complete: 'Details complete',
};

export function itemLine(i: Order['items'][number]): string {
  return [i.title, i.color, i.size].filter(Boolean).join(' · ') + ` × ${i.quantity}`;
}
