'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { Empty, Loading, Notice, TopBar } from '@/components/ui';
import { qs, useApi } from '@/lib/api';
import { actionLabel, dateTime } from '@/lib/format';
import type { AuditEntry } from '@/lib/types';

/** Short, readable details for an entry; the raw data is one click away. */
function summary(e: AuditEntry): string {
  const d = e.data as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof d.reason === 'string') parts.push(`Reason: ${d.reason}`);
  if (typeof d.note === 'string') parts.push(`Note: ${d.note}`);
  if (typeof d.credits === 'number') parts.push(`${d.credits > 0 ? '+' : ''}${d.credits} credits`);
  if (typeof d.days === 'number') parts.push(`${d.days} days`);
  if (typeof d.to === 'string') parts.push(`To ${d.to}`);
  if (typeof d.email === 'string') parts.push(d.email);
  if (typeof d.role === 'string') parts.push(d.role);
  return parts.join(' · ');
}

function Audit() {
  const params = useSearchParams();
  const workspaceId = params.get('workspaceId') ?? '';
  const api = useApi();
  const [action, setAction] = useState('');
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState<string>();

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(undefined);
      try {
        const r = await api<{ entries: AuditEntry[]; nextCursor: string | null }>(`/audit${qs({ workspaceId, action: action.trim(), cursor })}`);
        setRows((prev) => (cursor ? [...prev, ...r.entries] : r.entries));
        setNext(r.nextCursor);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [api, workspaceId, action],
  );

  useEffect(() => {
    load();
  }, [load]);

  return (
    <>
      <TopBar title="Audit log" back={workspaceId ? { href: `/tenants/${workspaceId}`, label: 'Shop' } : undefined}>
        <label className="field" style={{ flexDirection: 'row', alignItems: 'center' }}>
          Action
          <select className="input" value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">All</option>
            {[
              'auth.signed_in',
              'tenant.viewed',
              'tenant.suspended',
              'tenant.reactivated',
              'tenant.trial_extended',
              'tenant.plan_changed',
              'tenant.credits_adjusted',
              'conversation.viewed',
              'conversation.revealed',
              'conversation.replied',
              'plan.created',
              'plan.updated',
              'team.added',
              'team.updated',
              'settings.updated',
              'flag.set',
            ].map((a) => (
              <option key={a} value={a}>
                {actionLabel(a)}
              </option>
            ))}
          </select>
        </label>
        {workspaceId && (
          <a className="btn" href="/audit">
            All shops
          </a>
        )}
      </TopBar>
      <div className="content">
        <p className="muted" style={{ margin: 0 }}>
          Every view of shop data and every change by the Agently team, newest first. Entries can&apos;t be edited or deleted.
        </p>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="table-wrap">
          <table style={{ minWidth: 860 }}>
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>What</th>
                <th>Shop</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                    {dateTime(e.createdAt)}
                  </td>
                  <td>
                    {e.actor.name}
                    <div className="sub">{e.ip ?? ''}</div>
                  </td>
                  <td>{actionLabel(e.action)}</td>
                  <td>{e.workspace ? <a href={`/tenants/${e.workspace.id}`}>{e.workspace.name}</a> : '—'}</td>
                  <td style={{ maxWidth: 360 }}>
                    <span>{summary(e)}</span>
                    {Object.keys(e.data).length > 0 && (
                      <>
                        {' '}
                        <button type="button" className="btn link" style={{ fontSize: 12 }} onClick={() => setOpen(open === e.id ? undefined : e.id)} aria-expanded={open === e.id}>
                          {open === e.id ? 'Hide data' : 'Data'}
                        </button>
                        {open === e.id && <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{JSON.stringify(e.data, null, 2)}</pre>}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading && <Loading />}
          {!loading && rows.length === 0 && <Empty>No entries.</Empty>}
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

export default function AuditPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Audit />
    </Suspense>
  );
}
