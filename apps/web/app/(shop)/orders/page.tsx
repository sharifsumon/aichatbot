'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useShop } from '@/components/Shell';
import { Chips, Dialog, Empty, Loading, Notice, Pill, SearchBox, Stat, TopBar } from '@/components/ui';
import { qs, useApi } from '@/lib/api';
import { bdt, dateTime, num } from '@/lib/format';
import { METHOD, PAYMENT, STATUS, STEP, itemLine } from '@/lib/orders';
import type { Order, OrderStatus, PaymentStatus } from '@/lib/types';

type StatusFilter = 'all' | OrderStatus;
const STATUS_CHIPS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'shipped', label: 'Shipped' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'returned', label: 'Returned' },
  { value: 'cancelled', label: 'Cancelled' },
];

type Action = 'verify' | 'reject' | 'ship' | 'deliver' | 'return' | 'cancel';

function Orders() {
  const { ws, home, reloadHome } = useShop();
  const api = useApi();
  const router = useRouter();
  const params = useSearchParams();
  const openId = params.get('open');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [payment, setPayment] = useState<'' | PaymentStatus>((params.get('payment') as PaymentStatus) ?? '');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Order[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const [dialog, setDialog] = useState<{ action: Action; order: Order }>();

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(undefined);
      try {
        const r = await api<{ orders: Order[]; nextCursor: string | null }>(`${ws}/orders${qs({ status: status === 'all' ? '' : status, payment, q, cursor })}`);
        setRows((prev) => (cursor ? [...prev, ...r.orders] : r.orders));
        setNext(r.nextCursor);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [api, ws, status, payment, q],
  );

  useEffect(() => {
    load();
  }, [load]);

  const onSearch = useCallback((v: string) => setQ(v), []);
  const closeDetail = () => router.replace('/orders');
  const after = (message: string) => {
    setDialog(undefined);
    setDone(message);
    load();
    reloadHome();
  };

  function exportCsv() {
    const head = ['Order', 'Date', 'Customer', 'Phone', 'Address', 'Items', 'Subtotal', 'Delivery', 'Total', 'Status', 'Payment method', 'Payment', 'Transaction ID', 'Courier', 'Consignment'];
    const lines = rows.map((o) =>
      [
        `#${o.number}`,
        new Date(o.createdAt).toISOString(),
        o.customerName ?? '',
        o.phone ?? '',
        o.address ?? '',
        o.items.map(itemLine).join('; '),
        o.subtotal,
        o.deliveryCharge,
        o.total,
        STATUS[o.status].label,
        o.paymentMethod ? METHOD[o.paymentMethod] : '',
        PAYMENT[o.paymentStatus].label,
        o.paymentTransactionId ?? '',
        o.courier ?? '',
        o.consignmentId ?? '',
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(','),
    );
    const blob = new Blob([`﻿${[head.join(','), ...lines].join('\n')}`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `orders-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <>
      <TopBar title="Orders">
        <SearchBox label="Search orders" placeholder="Order no., name, phone, TrxID…" onSearch={onSearch} />
        <button type="button" className="btn" onClick={exportCsv} disabled={!rows.length}>
          Export CSV
        </button>
      </TopBar>
      <div className="content">
        {home && (
          <div className="stats">
            <Stat label="Orders today" value={num(home.stats.ordersToday)} />
            <Stat label="Awaiting payment check" value={num(home.stats.awaitingPayment)} tone={home.stats.awaitingPayment ? 'warn' : undefined} />
            <Stat label="To ship" value={num(home.stats.toShip)} />
            <Stat label="Revenue this month" value={bdt(home.stats.revenueThisMonth)} />
          </div>
        )}
        <div className="chips">
          <Chips label="Order status" options={STATUS_CHIPS} value={status} onChange={setStatus} />
          <label className="check" style={{ marginLeft: 'auto' }}>
            Payment
            <select className="input" value={payment} onChange={(e) => setPayment(e.target.value as PaymentStatus | '')}>
              <option value="">All</option>
              <option value="unpaid">Unpaid</option>
              <option value="cod_due">Cash on delivery</option>
              <option value="pending_verification">Awaiting verification</option>
              <option value="paid">Paid</option>
              <option value="rejected">Payment not found</option>
              <option value="refunded">Refunded</option>
            </select>
          </label>
        </div>
        {done && <Notice tone="ok">{done}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
        <div className="table-wrap">
          <table style={{ minWidth: 1040 }}>
            <thead>
              <tr>
                <th>Order</th>
                <th>Customer</th>
                <th>Items</th>
                <th>Delivery address</th>
                <th>Total</th>
                <th>Order status</th>
                <th>Payment</th>
                <th>
                  <span className="sr">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => {
                const main = mainAction(o);
                return (
                  <tr key={o.id} className={o.paymentStatus === 'pending_verification' ? 'attention' : undefined}>
                    <td>
                      <strong>#{o.number}</strong>
                      <div className="sub">
                        {dateTime(o.createdAt)} · by {o.source === 'ai' ? 'bot' : 'staff'}
                      </div>
                    </td>
                    <td>
                      {o.customerName ?? '—'}
                      <div className="sub">{o.phone}</div>
                    </td>
                    <td>
                      {o.items.map((i) => (
                        <div key={i.id}>{itemLine(i)}</div>
                      ))}
                    </td>
                    <td style={{ maxWidth: 220 }}>{o.address ?? <span className="sub">{STEP[o.checkoutStep]}</span>}</td>
                    <td>
                      <strong>{bdt(o.total)}</strong>
                      {Number(o.deliveryCharge) > 0 && <div className="sub">incl. {bdt(o.deliveryCharge)} delivery</div>}
                    </td>
                    <td>
                      <Pill tone={STATUS[o.status].tone}>{STATUS[o.status].label}</Pill>
                      {o.courier && (
                        <div className="sub">
                          {o.courier}
                          {o.consignmentId ? ` · ${o.consignmentId}` : ''}
                        </div>
                      )}
                    </td>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
                        <span>
                          {o.paymentMethod ? METHOD[o.paymentMethod] : '—'}
                          {o.paymentTransactionId && (
                            <>
                              {' · '}
                              <code>{o.paymentTransactionId}</code>
                            </>
                          )}
                        </span>
                        <Pill tone={PAYMENT[o.paymentStatus].tone}>{PAYMENT[o.paymentStatus].label}</Pill>
                      </div>
                    </td>
                    <td>
                      <div className="actions">
                        {main && (
                          <button type="button" className="btn sm primary" onClick={() => setDialog({ action: main, order: o })}>
                            {ACTION[main].label}
                          </button>
                        )}
                        <button type="button" className="btn sm" aria-label={`Open order ${o.number}`} onClick={() => router.push(`/orders?open=${o.id}`)}>
                          ⋯
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {loading && <Loading />}
          {!loading && rows.length === 0 && <Empty>{q || status !== 'all' || payment ? 'No orders match.' : 'No orders yet. Orders the bot takes in chat show up here.'}</Empty>}
          {next && !loading && (
            <div className="more">
              <button type="button" className="btn" onClick={() => load(next)}>
                Show more
              </button>
            </div>
          )}
        </div>
      </div>
      {openId && !dialog && <Detail id={openId} onClose={closeDetail} onAction={(action, order) => setDialog({ action, order })} />}
      {dialog && <ActionDialog {...dialog} onClose={() => setDialog(undefined)} onDone={after} />}
    </>
  );
}

const ACTION: Record<Action, { label: string; title: string; path: string; danger?: boolean }> = {
  verify: { label: 'Mark paid', title: 'Mark the payment as received', path: 'verify-payment' },
  reject: { label: 'Payment not found', title: 'Payment not found', path: 'verify-payment', danger: true },
  ship: { label: 'Mark shipped', title: 'Mark as shipped', path: 'ship' },
  deliver: { label: 'Mark delivered', title: 'Mark as delivered', path: 'deliver' },
  return: { label: 'Mark returned', title: 'Mark as returned', path: 'return', danger: true },
  cancel: { label: 'Cancel order', title: 'Cancel this order', path: 'cancel', danger: true },
};

function mainAction(o: Order): Action | undefined {
  if (o.paymentStatus === 'pending_verification') return 'verify';
  if (o.status === 'confirmed' && o.checkoutStep === 'complete') return 'ship';
  if (o.status === 'shipped') return 'deliver';
  return undefined;
}

function actionsFor(o: Order): Action[] {
  const out: Action[] = [];
  if (o.paymentStatus === 'pending_verification') out.push('verify', 'reject');
  if (o.status === 'confirmed' && o.checkoutStep === 'complete') out.push('ship');
  if (o.status === 'shipped') out.push('deliver', 'return');
  if (o.status === 'confirmed') out.push('cancel');
  return out;
}

function ActionDialog({ action, order, onClose, onDone }: { action: Action; order: Order; onClose: () => void; onDone: (m: string) => void }) {
  const { ws } = useShop();
  const api = useApi();
  const [courier, setCourier] = useState('');
  const [consignmentId, setConsignmentId] = useState('');
  const [trackingUrl, setTrackingUrl] = useState('');
  const a = ACTION[action];

  return (
    <Dialog
      title={`${a.title} · #${order.number}`}
      submitLabel={a.label}
      danger={a.danger}
      onClose={onClose}
      onSubmit={async () => {
        const body = action === 'verify' ? { found: true } : action === 'reject' ? { found: false } : action === 'ship' ? { courier, consignmentId, trackingUrl } : undefined;
        await api(`${ws}/orders/${order.id}/${a.path}`, { method: 'POST', body });
        onDone(`Order #${order.number}: ${a.label.toLowerCase()}.`);
      }}
    >
      {action === 'verify' && (
        <p className="muted" style={{ margin: 0 }}>
          Check your {order.paymentMethod ? METHOD[order.paymentMethod] : ''} account for {bdt(order.total)} with transaction ID <code>{order.paymentTransactionId}</code>
          {order.paymentSenderNumber ? ` from ${order.paymentSenderNumber}` : ''}.
        </p>
      )}
      {action === 'reject' && (
        <p className="muted" style={{ margin: 0 }}>
          Use this when no payment with this transaction ID reached your account. Let the customer know in the chat.
        </p>
      )}
      {action === 'ship' && (
        <>
          <label className="field">
            Courier
            <input value={courier} onChange={(e) => setCourier(e.target.value)} placeholder="Steadfast, Pathao, RedX…" />
          </label>
          <label className="field">
            Consignment ID
            <input value={consignmentId} onChange={(e) => setConsignmentId(e.target.value)} />
          </label>
          <label className="field">
            Tracking link <small>(optional)</small>
            <input value={trackingUrl} onChange={(e) => setTrackingUrl(e.target.value)} placeholder="https://" inputMode="url" />
          </label>
        </>
      )}
      {action === 'cancel' && (
        <p className="muted" style={{ margin: 0 }}>
          The items go back into stock. This can&apos;t be undone.
        </p>
      )}
      {action === 'return' && (
        <p className="muted" style={{ margin: 0 }}>
          The items go back into stock.
        </p>
      )}
      {action === 'deliver' && (
        <p className="muted" style={{ margin: 0 }}>
          {order.paymentMethod === 'cod' ? 'Cash on delivery orders are marked paid when delivered.' : 'The order is complete.'}
        </p>
      )}
    </Dialog>
  );
}

function Detail({ id, onClose, onAction }: { id: string; onClose: () => void; onAction: (a: Action, o: Order) => void }) {
  const { ws } = useShop();
  const api = useApi();
  const [o, setO] = useState<Order>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api<{ order: Order }>(`${ws}/orders/${id}`)
      .then((r) => setO(r.order))
      .catch((e: Error) => setError(e.message));
  }, [api, ws, id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog wide" role="dialog" aria-modal="true" aria-label="Order">
        {!o ? (
          error ? <Notice tone="error">{error}</Notice> : <Loading />
        ) : (
          <>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <h2>Order #{o.number}</h2>
              <Pill tone={STATUS[o.status].tone}>{STATUS[o.status].label}</Pill>
              <Pill tone={PAYMENT[o.paymentStatus].tone}>{PAYMENT[o.paymentStatus].label}</Pill>
              <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
                ×
              </button>
            </div>
            <dl className="kv">
              <dt>Placed</dt>
              <dd>
                {dateTime(o.createdAt)} by {o.source === 'ai' ? 'the bot' : 'staff'}
              </dd>
              <dt>Customer</dt>
              <dd>{[o.customerName, o.phone].filter(Boolean).join(' · ') || '—'}</dd>
              <dt>Address</dt>
              <dd>{o.address ?? STEP[o.checkoutStep]}</dd>
              <dt>Items</dt>
              <dd>
                {o.items.map((i) => (
                  <div key={i.id}>
                    {itemLine(i)} · {bdt(Number(i.unitPrice) * i.quantity)}
                  </div>
                ))}
              </dd>
              <dt>Delivery</dt>
              <dd>{bdt(o.deliveryCharge)}</dd>
              <dt>Total</dt>
              <dd>
                <strong>{bdt(o.total)}</strong>
              </dd>
              <dt>Payment</dt>
              <dd>
                {o.paymentMethod ? METHOD[o.paymentMethod] : 'Not chosen yet'}
                {o.paymentTransactionId && (
                  <>
                    {' · TrxID '}
                    <code>{o.paymentTransactionId}</code>
                  </>
                )}
                {o.paymentSenderNumber ? ` · from ${o.paymentSenderNumber}` : ''}
              </dd>
              {o.courier && (
                <>
                  <dt>Courier</dt>
                  <dd>
                    {o.courier}
                    {o.consignmentId ? ` · ${o.consignmentId}` : ''}
                    {o.trackingUrl && (
                      <>
                        {' · '}
                        <a href={o.trackingUrl} target="_blank" rel="noreferrer">
                          Track
                        </a>
                      </>
                    )}
                  </dd>
                </>
              )}
            </dl>
            <div className="buttons" style={{ flexWrap: 'wrap', justifyContent: 'flex-start' }}>
              {o.conversationId && (
                <Link className="btn" href={`/inbox?c=${o.conversationId}`}>
                  Open chat
                </Link>
              )}
              {actionsFor(o).map((a) => (
                <button key={a} type="button" className={`btn${ACTION[a].danger ? '' : ' primary'}`} onClick={() => onAction(a, o)}>
                  {ACTION[a].label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function OrdersPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Orders />
    </Suspense>
  );
}
