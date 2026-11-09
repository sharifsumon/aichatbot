'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '@/components/icons';
import { useShop } from '@/components/Shell';
import { Avatar, Chips, Empty, Loading, Notice, Pill, SearchBox } from '@/components/ui';
import { qs, useApi } from '@/lib/api';
import { ago, bdt, date, dateTime, num } from '@/lib/format';
import { METHOD, PAYMENT, STATUS, itemLine } from '@/lib/orders';
import type { ConversationDetail, ConversationRow, Message } from '@/lib/types';

type Filter = 'all' | 'human' | 'ai';

const CHANNEL: Record<string, string> = { facebook_page: 'Messenger', instagram: 'Instagram', whatsapp: 'WhatsApp', widget: 'Website chat', telegram: 'Telegram' };

function Inbox() {
  const { ws, home, reloadHome } = useShop();
  const api = useApi();
  const router = useRouter();
  const params = useSearchParams();
  const selected = params.get('c');
  const [filter, setFilter] = useState<Filter>((params.get('filter') as Filter) || 'all');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const load = useCallback(
    async (cursor?: string, quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const r = await api<{ conversations: ConversationRow[]; nextCursor: string | null }>(`${ws}/conversations${qs({ mode: filter === 'all' ? '' : filter, q, cursor })}`);
        setRows((prev) => (cursor ? [...prev, ...r.conversations] : r.conversations));
        if (!quiet || cursor) setNext(r.nextCursor);
        setError(undefined);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [api, ws, filter, q],
  );

  useEffect(() => {
    load();
    // New messages arrive while the page is open; refresh the first page quietly.
    const t = setInterval(() => load(undefined, true), 15_000);
    return () => clearInterval(t);
  }, [load]);

  const open = (id: string) => router.push(`/inbox${qs({ c: id, filter: filter === 'all' ? '' : filter })}`);
  const onSearch = useCallback((v: string) => setQ(v), []);

  return (
    <>
      <header className="top">
        <h1>Inbox</h1>
        <div className="right">
          <SearchBox label="Search conversations" placeholder="Customer name or phone…" onSearch={onSearch} />
        </div>
      </header>
      <div className={`inbox${selected ? ' has-chat' : ''}`}>
        <section className="inbox-list" aria-label="Conversations">
          <Chips
            label="Show"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'human', label: `Needs you${home?.stats.needsYou ? ` ${home.stats.needsYou}` : ''}` },
              { value: 'ai', label: 'Bot handling' },
            ]}
          />
          {error && <Notice tone="error">{error}</Notice>}
          {rows.map((c) => (
            <a
              key={c.id}
              className={`conv${c.id === selected ? ' on' : ''}`}
              href={`/inbox?c=${c.id}`}
              onClick={(e) => {
                e.preventDefault();
                open(c.id);
              }}
            >
              <Avatar name={c.customer.name} />
              <div className="body">
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <strong style={{ fontSize: 14 }}>{c.customer.name ?? 'Customer'}</strong>
                  <span className="sub" style={{ marginLeft: 'auto' }}>
                    {short(c.lastMessageAt)}
                  </span>
                </div>
                <span className="preview">{c.preview || '…'}</span>
                <div className="tags">
                  <Pill tone="brand">{CHANNEL[c.channel.type] ?? c.channel.type}</Pill>
                  {c.mode === 'human' ? <Pill tone="red">Needs you</Pill> : <Pill>Bot handling</Pill>}
                </div>
              </div>
            </a>
          ))}
          {loading && <Loading />}
          {!loading && rows.length === 0 && <Empty>{q ? 'No chats match.' : filter === 'human' ? 'Nothing needs you right now.' : 'No chats yet. They appear here when customers message your page.'}</Empty>}
          {next && !loading && (
            <div className="more">
              <button type="button" className="btn" onClick={() => load(next)}>
                Show more
              </button>
            </div>
          )}
        </section>
        {selected ? (
          <Chat
            key={selected}
            id={selected}
            onChanged={() => {
              load(undefined, true);
              reloadHome();
            }}
          />
        ) : (
          <section className="chat" aria-label="Conversation">
            <Empty>Pick a chat on the left to read it.</Empty>
          </section>
        )}
      </div>
    </>
  );
}

function Chat({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { ws, home } = useShop();
  const api = useApi();
  const [d, setD] = useState<ConversationDetail>();
  const [error, setError] = useState<string>();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState<string>();
  const end = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);

  const load = useCallback(async () => {
    try {
      setD(await api<ConversationDetail>(`${ws}/conversations/${id}`));
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, ws, id]);

  useEffect(() => {
    load();
    const t = setInterval(load, 8_000);
    return () => clearInterval(t);
  }, [load]);

  // Scroll to the newest message when one arrives.
  useEffect(() => {
    const n = d?.messages.length ?? 0;
    if (n !== lastCount.current) end.current?.scrollIntoView({ block: 'end' });
    lastCount.current = n;
  }, [d]);

  async function act(path: 'takeover' | 'return-to-ai') {
    setBusy(true);
    try {
      await api(`${ws}/conversations/${id}/${path}`, { method: 'POST' });
      await load();
      onChanged();
    } catch (e) {
      setSendError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!text.trim()) return;
    setBusy(true);
    setSendError(undefined);
    try {
      await api(`${ws}/conversations/${id}/reply`, { method: 'POST', body: { text } });
      setText('');
      await load();
      onChanged();
    } catch (e) {
      setSendError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  }

  if (!d) {
    return <section className="chat">{error ? <Notice tone="error">{error}</Notice> : <Loading />}</section>;
  }

  const c = d.conversation;
  const lastInbound = [...d.messages].reverse().find((m) => m.direction === 'inbound');
  const isComment = lastInbound?.kind === 'comment';
  const canSend = c.channel.status === 'connected' && (c.canReply || isComment);
  const botName = home?.agent?.name ?? 'The bot';

  return (
    <>
      <section className="chat" aria-label={`Conversation with ${c.customer.name ?? 'customer'}`}>
        <div className="chat-head">
          <Link href="/inbox" className="btn sm back-link" aria-label="Back to chats">
            ←
          </Link>
          <Avatar name={c.customer.name} />
          <div className="who">
            <strong>{c.customer.name ?? 'Customer'}</strong>
            <span className="sub">
              {CHANNEL[c.channel.type] ?? c.channel.type} · {c.channel.name}
            </span>
          </div>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {c.mode === 'ai' ? <Pill tone="brand">{botName} (AI) is replying</Pill> : <Pill tone="red">{c.handoffReason ?? 'You are replying'}</Pill>}
            {c.mode === 'ai' ? (
              <button type="button" className="btn sm" disabled={busy} onClick={() => act('takeover')}>
                Take over
              </button>
            ) : (
              <button type="button" className="btn sm" disabled={busy} onClick={() => act('return-to-ai')}>
                Hand back to bot
              </button>
            )}
          </span>
        </div>
        <div className="thread">
          {d.messages.map((m) => (
            <Bubble key={m.id} m={m} botName={botName} />
          ))}
          {d.messages.length === 0 && <Empty>No messages yet.</Empty>}
          <div ref={end} />
        </div>
        {sendError && (
          <div style={{ padding: '0 24px 8px' }}>
            <Notice tone="error">{sendError}</Notice>
          </div>
        )}
        {canSend ? (
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <label style={{ flex: 1, display: 'flex' }}>
              <span className="sr">Reply</span>
              <textarea
                rows={1}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKey}
                maxLength={2000}
                placeholder={isComment ? 'Reply publicly under their comment…' : c.mode === 'ai' ? 'Type a reply (the bot pauses when you send)…' : 'Type a reply…'}
              />
            </label>
            <button type="submit" className="send" aria-label="Send" disabled={busy || !text.trim()}>
              <Icon.send />
            </button>
          </form>
        ) : (
          <div className="composer">
            <span className="muted" style={{ fontSize: 13 }}>
              {c.channel.status !== 'connected'
                ? 'This page is not connected, so replies can’t be sent. Reconnect it in Settings.'
                : 'Facebook only allows replies within 24 hours of the customer’s last message. You can reply once they write again.'}
            </span>
          </div>
        )}
      </section>
      <Customer d={d} onChanged={load} />
    </>
  );
}

function Bubble({ m, botName }: { m: Message; botName: string }) {
  if (m.sender === 'system') return <div className="msg system">{m.text}</div>;
  const cls = m.sender === 'customer' ? 'in' : m.sender;
  const who = m.sender === 'ai' ? botName : m.sender === 'staff' ? 'You' : m.sender === 'support' ? 'Agently support' : null;
  const where = m.kind === 'comment' ? 'Comment on a post' : m.kind === 'comment_reply' ? 'Public reply' : m.kind === 'private_reply' ? 'Private reply' : null;
  return (
    <div className={`msg ${cls}${m.kind === 'comment' ? ' is-comment' : ''}${m.delivery === 'failed' ? ' failed' : ''}`}>
      {m.text}
      {m.attachments.map((a, i) =>
        a.type === 'image' && a.url ? (
          <a key={i} className="msg-img" href={a.url} target="_blank" rel="noreferrer">
            <img src={a.url} alt="Photo" loading="lazy" />
          </a>
        ) : (
          <span key={i}>[{a.type}]</span>
        ),
      )}
      <div className="msg-meta">
        {[who, where, dateTime(m.createdAt), m.delivery === 'failed' ? 'Not delivered' : null].filter(Boolean).join(' · ')}
      </div>
    </div>
  );
}

function Customer({ d, onChanged }: { d: ConversationDetail; onChanged: () => void }) {
  const { ws, reloadHome } = useShop();
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const c = d.conversation.customer;
  const o = d.orders[0];

  async function verify(found: boolean) {
    if (!o) return;
    setBusy(true);
    setError(undefined);
    try {
      await api(`${ws}/orders/${o.id}/verify-payment`, { method: 'POST', body: { found } });
      onChanged();
      reloadHome();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="cust" aria-label="Customer details">
      <div className="block">
        <span className="label">Customer</span>
        <strong>{c.name ?? 'Customer'}</strong>
        {c.phone && <span>{c.phone}</span>}
        {c.address && <span>{c.address}</span>}
      </div>
      {o ? (
        <div className="order-card">
          <div className="line">
            <strong style={{ fontSize: 14 }}>Order #{o.number}</strong>
            <Pill tone={STATUS[o.status].tone}>{STATUS[o.status].label}</Pill>
          </div>
          {o.items.map((i) => (
            <span key={i.id} className="muted">
              {itemLine(i)}
            </span>
          ))}
          <div className="line">
            <span>Total</span>
            <strong>{bdt(o.total)}</strong>
          </div>
          <div className="line">
            <span>Payment</span>
            <span>{o.paymentMethod ? METHOD[o.paymentMethod] : 'Not chosen yet'}</span>
          </div>
          {o.paymentTransactionId && (
            <div className="line">
              <span>TrxID</span>
              <code>{o.paymentTransactionId}</code>
            </div>
          )}
          <span>
            <Pill tone={PAYMENT[o.paymentStatus].tone}>{PAYMENT[o.paymentStatus].label}</Pill>
          </span>
          {error && <Notice tone="error">{error}</Notice>}
          {o.paymentStatus === 'pending_verification' && (
            <>
              <button type="button" className="btn primary" disabled={busy} onClick={() => verify(true)}>
                Mark as paid
              </button>
              <button type="button" className="btn sm" disabled={busy} onClick={() => verify(false)}>
                Payment not found
              </button>
            </>
          )}
          <Link href={`/orders?open=${o.id}`} style={{ fontSize: 13, fontWeight: 600, textAlign: 'center' }}>
            Open in Orders
          </Link>
        </div>
      ) : (
        <span className="muted" style={{ fontSize: 13 }}>
          No orders yet. When the bot takes an order in this chat, it shows here.
        </span>
      )}
      {d.history.orders > 0 && (
        <div className="block">
          <span className="label">History</span>
          <span style={{ fontSize: 13 }}>
            {num(d.history.orders)} order{d.history.orders === 1 ? '' : 's'} · {bdt(d.history.total)} total
            {d.history.firstOrderAt ? ` · first order ${date(d.history.firstOrderAt)}` : ''}
          </span>
        </div>
      )}
    </aside>
  );
}

/** "2m", "1h", "3d" like the design; older shows the date. */
function short(at: string): string {
  const min = Math.round((Date.now() - new Date(at).getTime()) / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  if (min < 60 * 24) return `${Math.round(min / 60)}h`;
  if (min < 60 * 24 * 7) return `${Math.round(min / 1440)}d`;
  return ago(at);
}

export default function InboxPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Inbox />
    </Suspense>
  );
}
