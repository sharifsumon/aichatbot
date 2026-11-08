'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { Chips, Empty, Loading, Notice, Pill, TopBar } from '@/components/ui';
import { qs, useApi, useLoad } from '@/lib/api';
import { ago } from '@/lib/format';
import type { ConversationRow, TenantDetail } from '@/lib/types';

type Filter = 'all' | 'human' | 'ai' | 'handedOff' | 'flagged' | 'failed';
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'handedOff', label: 'Handed to staff' },
  { value: 'failed', label: 'Failed replies' },
  { value: 'flagged', label: 'Flagged' },
  { value: 'ai', label: 'AI handling' },
  { value: 'human', label: 'Staff handling' },
];

function Conversations() {
  const params = useSearchParams();
  const workspaceId = params.get('workspaceId') ?? '';
  const api = useApi();
  const [filter, setFilter] = useState<Filter>((params.get('filter') as Filter) ?? 'all');
  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const shop = useLoad<TenantDetail>(workspaceId ? `/tenants/${workspaceId}` : null);

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(undefined);
      try {
        const query = qs({
          workspaceId,
          mode: filter === 'ai' || filter === 'human' ? filter : '',
          handedOff: filter === 'handedOff',
          flagged: filter === 'flagged',
          failed: filter === 'failed',
          cursor,
        });
        const r = await api<{ conversations: ConversationRow[]; nextCursor: string | null }>(`/conversations${query}`);
        setRows((prev) => (cursor ? [...prev, ...r.conversations] : r.conversations));
        setNext(r.nextCursor);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [api, filter, workspaceId],
  );

  useEffect(() => {
    load();
  }, [load]);

  return (
    <>
      <TopBar title={shop.data ? `Conversations · ${shop.data.tenant.name}` : 'Conversations'} back={workspaceId ? { href: `/tenants/${workspaceId}`, label: shop.data?.tenant.name ?? 'Shop' } : undefined}>
        {workspaceId && (
          <a className="btn" href="/conversations">
            All shops
          </a>
        )}
      </TopBar>
      <div className="content">
        <Notice tone="info">Phone numbers and addresses are hidden. Opening a chat, showing contact details and replying are all recorded in the audit log.</Notice>
        <Chips label="Filter conversations" options={FILTERS} value={filter} onChange={setFilter} />
        {error && <Notice tone="error">{error}</Notice>}
        <div className="table-wrap">
          <table style={{ minWidth: 860 }}>
            <thead>
              <tr>
                <th>Customer</th>
                {!workspaceId && <th>Shop</th>}
                <th>Last message</th>
                <th>Handled by</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => (window.location.href = `/conversations/${c.id}`)}>
                  <td>
                    <a href={`/conversations/${c.id}`} style={{ fontWeight: 700, color: 'inherit' }}>
                      {c.customerName ?? 'Customer'}
                    </a>
                    <div className="sub">{c.channel.name}</div>
                  </td>
                  {!workspaceId && <td>{c.workspace.name}</td>}
                  <td style={{ maxWidth: 360 }}>
                    <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.preview ?? ''}</span>
                    <div className="chips" style={{ marginTop: 6, gap: 6 }}>
                      {c.hasFailedReply && <Pill tone="red">Reply failed</Pill>}
                      {c.flagged && <Pill tone="amber">Flagged</Pill>}
                      {c.handoffReason && <Pill tone="violet">Handed off: {c.handoffReason}</Pill>}
                    </div>
                  </td>
                  <td>{c.mode === 'ai' ? <Pill tone="brand">AI</Pill> : <Pill>Staff</Pill>}</td>
                  <td className="muted">{ago(c.lastMessageAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading && <Loading />}
          {!loading && rows.length === 0 && <Empty>No conversations match.</Empty>}
          {next && !loading && (
            <div className="more">
              <button type="button" className="btn" onClick={() => load(next)}>
                Show more
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export default function ConversationsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Conversations />
    </Suspense>
  );
}
