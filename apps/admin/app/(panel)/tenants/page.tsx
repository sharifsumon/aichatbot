'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAdmin } from '@/components/Shell';
import { ACTION_LABEL, TenantActionDialog, useTenantActions, type TenantAction } from '@/components/TenantActions';
import { Chips, Empty, Loading, Meter, Notice, SearchBox, Stat, StatusPill, TopBar } from '@/components/ui';
import { qs, useApi, useLoad } from '@/lib/api';
import { ago, daysLeft, num, usd } from '@/lib/format';
import type { Overview, TenantRow, TenantStatus } from '@/lib/types';

type Filter = 'all' | TenantStatus;
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'trial', label: 'On trial' },
  { value: 'active', label: 'Active' },
  { value: 'past_due', label: 'Payment overdue' },
  { value: 'suspended', label: 'Suspended' },
];

export default function TenantsPage() {
  const me = useAdmin();
  const api = useApi();
  const actionsFor = useTenantActions();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<Filter>('all');
  const [rows, setRows] = useState<TenantRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const [dialog, setDialog] = useState<{ action: TenantAction; tenant: TenantRow }>();
  const overview = useLoad<Overview>(me.can('usage.read') ? '/overview' : null);

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(undefined);
      try {
        const r = await api<{ tenants: TenantRow[]; nextCursor: string | null }>(`/tenants${qs({ q, status: status === 'all' ? '' : status, cursor })}`);
        setRows((prev) => (cursor ? [...prev, ...r.tenants] : r.tenants));
        setNext(r.nextCursor);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [api, q, status],
  );

  useEffect(() => {
    load();
  }, [load]);

  const onSearch = useCallback((v: string) => setQ(v), []);
  const o = overview.data;

  return (
    <>
      <TopBar title="Tenants">
        <SearchBox label="Search tenants" placeholder="Shop, owner name or email…" onSearch={onSearch} />
      </TopBar>
      <div className="content">
        {o && (
          <div className="stats">
            <Stat label="Active shops" value={num(o.tenants.active)} />
            <Stat label="On trial" value={num(o.tenants.trial)} />
            <Stat label="Out of AI credits" value={num(o.tenants.outOfCredits)} tone={o.tenants.outOfCredits ? 'bad' : undefined} />
            <Stat label="AI cost this month" value={usd(o.aiCostThisMonthUsd)} />
            <Stat label="Revenue per month" value={`৳${num(Math.round(Number(o.mrr?.bdt ?? 0)))}`} />
          </div>
        )}
        <Chips label="Filter by status" options={FILTERS} value={status} onChange={setStatus} />
        {done && <Notice tone="ok">{done}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
        <div className="table-wrap">
          <table style={{ minWidth: 1000 }}>
            <thead>
              <tr>
                <th>Shop</th>
                <th>Plan</th>
                <th>Status</th>
                <th>Pages</th>
                <th>AI credits used</th>
                <th>Orders (30 days)</th>
                <th>Last active</th>
                <th>
                  <span className="sr">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                // Same rule as the overview count: replies this month have reached what was granted.
                const out = t.status !== 'suspended' && t.aiRepliesThisMonth >= t.creditsGranted;
                const actions = actionsFor(t);
                // The one action the design puts next to "View chats" for this shop's state.
                const main: TenantAction | undefined = out && actions.includes('credits') ? 'credits' : t.status === 'trial' && actions.includes('trial') ? 'trial' : undefined;
                return (
                  <tr key={t.id} className={out || t.status === 'suspended' ? 'attention' : undefined}>
                    <td>
                      <a href={`/tenants/${t.id}`} style={{ fontWeight: 700, color: 'inherit' }}>
                        {t.name}
                      </a>
                      <div className="sub">{[t.owner?.name, t.owner?.email].filter(Boolean).join(' · ') || 'No owner'}</div>
                    </td>
                    <td>{t.plan?.name ?? '—'}</td>
                    <td>
                      <StatusPill status={t.status} trialDaysLeft={daysLeft(t.trialEndsAt)} outOfCredits={out} />
                    </td>
                    <td className="num">{t.pagesConnected}</td>
                    <td>
                      <Meter used={t.aiRepliesThisMonth} total={t.creditsGranted} />
                    </td>
                    <td className="num">{num(t.ordersLast30Days)}</td>
                    <td className="muted">{ago(t.lastActiveAt)}</td>
                    <td>
                      <div className="actions">
                        {me.can('conversations') && (
                          <a className="btn sm" href={`/conversations?workspaceId=${t.id}`}>
                            View chats
                          </a>
                        )}
                        {main && (
                          <button type="button" className="btn sm" onClick={() => setDialog({ action: main, tenant: t })}>
                            {ACTION_LABEL[main]}
                          </button>
                        )}
                        <a className="btn sm" href={`/tenants/${t.id}`} aria-label={`Open ${t.name}`}>
                          Open
                        </a>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {loading && <Loading />}
          {!loading && rows.length === 0 && <Empty>{q || status !== 'all' ? 'No shops match.' : 'No shops yet.'}</Empty>}
          {next && !loading && (
            <div className="more">
              <button type="button" className="btn" onClick={() => load(next)}>
                Show more
              </button>
            </div>
          )}
        </div>
        <p className="sub" style={{ margin: 0 }}>
          Every chat view, reply and change is recorded in the audit log.
        </p>
      </div>
      {dialog && (
        <TenantActionDialog
          action={dialog.action}
          tenant={{ ...dialog.tenant, planKey: dialog.tenant.plan?.key }}
          onClose={() => setDialog(undefined)}
          onDone={(m) => {
            setDialog(undefined);
            setDone(m);
            load();
            overview.reload();
          }}
        />
      )}
    </>
  );
}
