'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Icon } from '@/components/icons';
import { useShop } from '@/components/Shell';
import { Avatar, Chips, Empty, Loading, Notice, Pill, Toggle, TopBar } from '@/components/ui';
import { qs, useApi, useLoad } from '@/lib/api';
import { ago } from '@/lib/format';
import type { Agent, Comment } from '@/lib/types';

type Filter = 'all' | 'needs_you' | 'answered';

/** Comments on the shop's posts, grouped by post, with the bot's replies under each. */
export default function CommentsPage() {
  const { ws, manager } = useShop();
  const api = useApi();
  const [filter, setFilter] = useState<Filter>('all');
  const [rows, setRows] = useState<Comment[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const agent = useLoad<{ agent: Agent }>(`${ws}/agent`);
  const [modeError, setModeError] = useState<string>();

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(undefined);
      try {
        const r = await api<{ comments: Comment[]; nextCursor: string | null }>(`${ws}/comments${qs({ filter: filter === 'all' ? '' : filter, cursor })}`);
        setRows((prev) => (cursor ? [...prev, ...r.comments] : r.comments));
        setNext(r.nextCursor);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [api, ws, filter],
  );

  useEffect(() => {
    load();
  }, [load]);

  // One card per post, in the order their newest comment arrived.
  const posts = useMemo(() => {
    const m = new Map<string, Comment[]>();
    for (const c of rows) {
      const k = c.postId ?? 'unknown';
      m.set(k, [...(m.get(k) ?? []), c]);
    }
    return [...m.entries()];
  }, [rows]);

  const a = agent.data?.agent;
  async function setAuto(on: boolean) {
    setModeError(undefined);
    try {
      await api(`${ws}/agent`, { method: 'PATCH', body: { commentReplyMode: on ? 'public_and_private' : 'off' } });
      agent.reload();
    } catch (e) {
      setModeError((e as Error).message);
    }
  }

  return (
    <>
      <TopBar title="Comments">
        {a && <Toggle checked={a.commentReplyMode !== 'off'} disabled={!manager} onChange={setAuto} label="Bot replies automatically" />}
      </TopBar>
      <div className="content narrow">
        {modeError && <Notice tone="error">{modeError}</Notice>}
        {a && a.commentReplyMode !== 'off' && (
          <p className="sub" style={{ margin: 0 }}>
            {a.commentReplyMode === 'public_and_private'
              ? 'The bot answers in a private message and leaves a short public reply saying so.'
              : a.commentReplyMode === 'public'
                ? 'The bot answers publicly under the comment.'
                : 'The bot answers in a private message only.'}{' '}
            {manager && <Link href="/agent">Change this</Link>}
          </p>
        )}
        <Chips
          label="Show"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'needs_you', label: 'Needs you' },
            { value: 'answered', label: 'Answered' },
          ]}
        />
        {error && <Notice tone="error">{error}</Notice>}
        {posts.map(([postId, comments]) => (
          <section key={postId} className="post" aria-label="Post">
            <div className="post-head">
              <div className="thumb">
                <Icon.post />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                <strong>Post on {comments[0]!.channel.name}</strong>
                <span className="sub">
                  Facebook · {comments.length} comment{comments.length === 1 ? '' : 's'} here
                </span>
              </div>
              {postId !== 'unknown' && (
                <a href={`https://www.facebook.com/${postId}`} target="_blank" rel="noreferrer" style={{ fontSize: 13, fontWeight: 600 }}>
                  View post
                </a>
              )}
            </div>
            {comments.map((c) => (
              <CommentRow key={c.id} c={c} onReplied={() => load()} />
            ))}
          </section>
        ))}
        {loading && <Loading />}
        {!loading && rows.length === 0 && <Empty>{filter === 'needs_you' ? 'Every comment has a reply.' : 'No comments yet. Comments on your page’s posts show up here.'}</Empty>}
        {next && !loading && (
          <div className="more">
            <button type="button" className="btn" onClick={() => load(next)}>
              Show more
            </button>
          </div>
        )}
      </div>
    </>
  );
}

function CommentRow({ c, onReplied }: { c: Comment; onReplied: () => void }) {
  const { ws, home } = useShop();
  const api = useApi();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const answered = c.replies.some((r) => r.delivery !== 'failed');
  const bot = home?.agent?.name ?? 'Bot';

  async function reply(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api(`${ws}/comments/${c.id}/reply`, { method: 'POST', body: { text } });
      setText('');
      onReplied();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="comment">
      <Avatar name={c.customer.name} size={36} />
      <div className="body">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong>{c.customer.name ?? 'Someone'}</strong>
          <span className="sub">{ago(c.createdAt)}</span>
          <span style={{ marginLeft: 'auto' }}>{answered ? <Pill tone="green">Answered</Pill> : <Pill tone="red">Needs you</Pill>}</span>
        </div>
        <p>{c.text}</p>
        {c.replies.map((r) => (
          <div key={r.id} className={`reply${r.delivery === 'failed' ? ' failed' : ''}`}>
            <span className="sub">
              {r.sender === 'ai' ? `${bot} (bot)` : r.sender === 'staff' ? 'Your team' : r.sender === 'support' ? 'Agently support' : 'System'} ·{' '}
              {r.kind === 'private_reply' ? 'private message' : r.kind === 'comment_reply' ? 'public reply' : 'message'}
              {r.delivery === 'failed' ? ' · not delivered' : ''}
            </span>
            <span>{r.text}</span>
          </div>
        ))}
        {!answered && (
          <form className="inline-form" onSubmit={reply}>
            <label style={{ display: 'contents' }}>
              <span className="sr">Reply to {c.customer.name ?? 'this comment'}</span>
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a public reply…" maxLength={2000} />
            </label>
            <button type="submit" className="btn primary" disabled={busy || !text.trim()}>
              {busy ? 'Sending…' : 'Reply publicly'}
            </button>
            <Link className="btn" href={`/inbox?c=${c.conversationId}`}>
              Open chat
            </Link>
          </form>
        )}
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </div>
  );
}
