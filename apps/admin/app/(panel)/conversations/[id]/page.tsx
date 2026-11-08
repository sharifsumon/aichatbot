'use client';

import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Empty, Loading, Notice, Pill, TopBar } from '@/components/ui';
import { qs, useApi, useLoad } from '@/lib/api';
import { bdt, dateTime } from '@/lib/format';
import type { ConversationDetail, Message } from '@/lib/types';

const SENDER: Record<Message['sender'], string> = { customer: 'Customer', ai: 'AI', staff: 'Shop staff', support: 'Agently support', system: 'System' };

function bubbleClass(m: Message) {
  if (m.sender === 'system') return 'msg system';
  if (m.direction === 'inbound') return 'msg in';
  return `msg ${m.sender === 'ai' ? 'ai' : m.sender === 'support' ? 'support' : 'staff'}${m.delivery === 'failed' ? ' failed' : ''}`;
}

export default function ConversationPage() {
  const { id } = useParams<{ id: string }>();
  const api = useApi();
  const [reveal, setReveal] = useState(false);
  const { data, error, loading, reload } = useLoad<ConversationDetail>(`/conversations/${id}${qs({ reveal })}`);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();

  if (!data) {
    return (
      <>
        <TopBar title="Conversation" back={{ href: '/conversations', label: 'Conversations' }} />
        <div className="content">{error ? <Notice tone="error">{error}</Notice> : loading && <Loading />}</div>
      </>
    );
  }

  const c = data.conversation;

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setActionError(undefined);
    try {
      await api(`/conversations/${c.id}/reply`, { method: 'POST', body: { text: text.trim() } });
      setText('');
      reload();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleFlag() {
    setActionError(undefined);
    try {
      await api(`/conversations/${c.id}/flag`, { method: 'POST', body: { flagged: !c.flagged } });
      reload();
    } catch (err) {
      setActionError((err as Error).message);
    }
  }

  return (
    <>
      <TopBar title={c.customer.name ?? 'Customer'} back={{ href: `/conversations?workspaceId=${c.workspaceId}`, label: 'Conversations' }}>
        {c.mode === 'ai' ? <Pill tone="brand">AI is replying</Pill> : <Pill>Staff handling{c.handoffReason ? `: ${c.handoffReason}` : ''}</Pill>}
        <button type="button" className="btn" onClick={toggleFlag}>
          {c.flagged ? 'Remove flag' : 'Flag for review'}
        </button>
        <a className="btn" href={`/tenants/${c.workspaceId}`}>
          Open shop
        </a>
      </TopBar>
      <div style={{ display: 'flex', flexWrap: 'wrap', flex: 1, minHeight: 0 }}>
        <section aria-label="Messages" style={{ flex: '999 1 420px', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div className="thread">
            {data.messages.length === 0 && <Empty>No messages.</Empty>}
            {data.messages.map((m) => (
              <div key={m.id} className={bubbleClass(m)}>
                {m.kind === 'comment' && <div className="msg-meta">Comment on a post</div>}
                {m.text || <em>(attachment)</em>}
                <div className="msg-meta">
                  {SENDER[m.sender]} · {dateTime(m.createdAt)}
                  {m.delivery === 'failed' ? ` · not delivered${m.meta.error ? `: ${m.meta.error}` : ''}` : ''}
                  {m.meta.sources?.length ? ` · used ${m.meta.sources.length} source${m.meta.sources.length === 1 ? '' : 's'}` : ''}
                </div>
              </div>
            ))}
          </div>
          <form onSubmit={send} style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '16px 24px', background: '#fff', borderTop: '1px solid var(--line)', marginTop: 'auto' }}>
            {actionError && <Notice tone="error">{actionError}</Notice>}
            {c.canReply ? (
              <>
                <div style={{ display: 'flex', gap: 10 }}>
                  <label style={{ flex: 1, display: 'flex' }}>
                    <span className="sr">Reply as Agently support</span>
                    <input className="input" style={{ flex: 1, height: 44 }} placeholder="Reply as Agently support…" value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} />
                  </label>
                  <button className="btn primary" style={{ height: 44 }} disabled={busy || !text.trim()}>
                    {busy ? 'Sending…' : 'Send'}
                  </button>
                </div>
                <span className="sub">The customer sees this from the shop&apos;s page. The shop sees it labelled as Agently support, and the AI stops in this chat.</span>
              </>
            ) : (
              <span className="muted">Meta only allows replies within 24 hours of the customer&apos;s last message, so this chat can&apos;t be answered now.</span>
            )}
          </form>
        </section>
        <aside aria-label="Customer and sources" style={{ flex: '1 1 300px', maxWidth: 380, background: '#fff', borderLeft: '1px solid var(--line)', padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span className="label">Customer</span>
            <strong>{c.customer.name ?? 'Customer'}</strong>
            <span className="muted">{c.customer.phone ?? 'No phone yet'}</span>
            <span className="muted">{c.customer.address ?? 'No address yet'}</span>
            <span className="sub">
              {c.channel.name} · {c.channel.type === 'facebook_page' ? 'Facebook' : c.channel.type}
            </span>
            {data.masked ? (
              <button type="button" className="btn sm" style={{ alignSelf: 'flex-start', marginTop: 4 }} onClick={() => setReveal(true)}>
                Show contact details
              </button>
            ) : (
              <span className="sub">Contact details shown. This is in the audit log.</span>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span className="label">What the AI used</span>
            {data.sources.products.length === 0 && data.sources.chunks.length === 0 && <span className="muted">No sources in these messages.</span>}
            {data.sources.products.map((p) => (
              <div key={p.id} className="card" style={{ padding: 12, fontSize: 13 }}>
                <strong>{p.title}</strong>
                {p.code ? ` · ${p.code}` : ''} · {bdt(p.price)}
              </div>
            ))}
            {data.sources.chunks.map((ch) => (
              <div key={ch.id} className="card" style={{ padding: 12, fontSize: 13, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span className="sub">{ch.source}</span>
                <span style={{ whiteSpace: 'pre-wrap' }}>{ch.content.length > 400 ? `${ch.content.slice(0, 400)}…` : ch.content}</span>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </>
  );
}
