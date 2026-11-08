'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useAdmin } from '@/components/Shell';
import { ACTION_LABEL, TenantActionDialog, useTenantActions, type TenantAction } from '@/components/TenantActions';
import { DayChart, Empty, Loading, Meter, Notice, Pill, Stat, StatusPill, TopBar } from '@/components/ui';
import { qs, useLoad } from '@/lib/api';
import { actionLabel, date, dateTime, daysLeft, num, usd } from '@/lib/format';
import type { AuditEntry, TenantDetail } from '@/lib/types';

const CHANNEL_STATUS: Record<string, { label: string; tone: 'green' | 'red' | 'amber' }> = {
  connected: { label: 'Connected', tone: 'green' },
  token_expired: { label: 'Needs reconnecting', tone: 'amber' },
  error: { label: 'Error', tone: 'red' },
  disconnected: { label: 'Disconnected', tone: 'red' },
};

export default function TenantPage() {
  const { id } = useParams<{ id: string }>();
  const me = useAdmin();
  const actionsFor = useTenantActions();
  const { data, error, loading, reload } = useLoad<TenantDetail>(`/tenants/${id}`);
  const audit = useLoad<{ entries: AuditEntry[] }>(me.can('audit.read') ? `/audit${qs({ workspaceId: id, limit: 10 })}` : null);
  const [dialog, setDialog] = useState<TenantAction>();
  const [done, setDone] = useState<string>();

  if (!data) {
    return (
      <>
        <TopBar title="Tenant" back={{ href: '/tenants', label: 'Tenants' }} />
        <div className="content">{error ? <Notice tone="error">{error}</Notice> : loading && <Loading />}</div>
      </>
    );
  }

  const t = data.tenant;
  const totals = data.usage.reduce(
    (a, d) => ({ replies: a.replies + d.aiReplies, cost: a.cost + Number(d.costUsd), failed: a.failed + d.failedCalls, tokens: a.tokens + d.inputTokens + d.outputTokens }),
    { replies: 0, cost: 0, failed: 0, tokens: 0 },
  );
  const owner = data.members.find((m) => m.role === 'owner');

  return (
    <>
      <TopBar title={t.name} back={{ href: '/tenants', label: 'Tenants' }}>
        <StatusPill status={t.status} trialDaysLeft={daysLeft(t.trialEndsAt)} outOfCredits={t.status !== 'suspended' && data.credits.warning === 'out'} />
        {me.can('conversations') && (
          <a className="btn" href={`/conversations?workspaceId=${t.id}`}>
            View chats
          </a>
        )}
        {actionsFor(t).map((a) => (
          <button key={a} type="button" className={`btn${a === 'suspend' ? ' danger' : ''}`} onClick={() => setDialog(a)}>
            {ACTION_LABEL[a]}
          </button>
        ))}
      </TopBar>
      <div className="content">
        {done && <Notice tone="ok">{done}</Notice>}
        {t.status === 'suspended' && (
          <Notice tone="error">
            <strong>Suspended.</strong> The owner sees this reason: {t.suspendedReason}
          </Notice>
        )}

        <div className="stats">
          <Stat label="AI credits this month" value={`${num(data.credits.used)} / ${num(data.credits.granted)}`} note={`${num(data.credits.remaining)} left · resets ${date(data.credits.periodEnd)}`} tone={data.credits.warning === 'out' ? 'bad' : data.credits.warning === 'low' ? 'warn' : undefined} />
          <Stat label="AI cost (30 days)" value={usd(totals.cost)} note={`${num(totals.tokens)} tokens`} />
          <Stat label="Failed AI calls (30 days)" value={num(totals.failed)} tone={totals.failed ? 'warn' : undefined} />
          <Stat label="Products" value={num(data.counts.products)} />
          <Stat label="Orders (all time)" value={num(data.counts.orders)} />
        </div>

        <div className="grid2">
          <section className="card pad" aria-label="Shop">
            <h2>Shop</h2>
            <dl className="kv">
              <dt>Owner</dt>
              <dd>{owner ? [owner.name, owner.email].filter(Boolean).join(' · ') : '—'}</dd>
              <dt>Plan</dt>
              <dd>{t.plan?.name ?? 'None'}</dd>
              {t.trialEndsAt && (
                <>
                  <dt>Trial ends</dt>
                  <dd>{date(t.trialEndsAt)}</dd>
                </>
              )}
              <dt>Country</dt>
              <dd>
                {t.billingCountry} · {t.currency} · {t.locale === 'bn' ? 'Bangla' : 'English'}
              </dd>
              <dt>Signed up</dt>
              <dd>{date(t.createdAt)}</dd>
              <dt>Shop id</dt>
              <dd>
                <code>{t.id}</code>
              </dd>
            </dl>
            {t.plan && (
              <p className="sub" style={{ margin: 0 }}>
                Plan limits: {t.plan.limits.pages} pages · {num(t.plan.limits.aiCreditsPerMonth)} credits a month · {t.plan.limits.staffSeats} staff · {t.plan.limits.knowledgeBaseMb} MB knowledge base
              </p>
            )}
          </section>

          <section className="card pad" aria-label="Credits">
            <h2>AI credits</h2>
            <Meter used={data.credits.used} total={data.credits.granted} label={`${num(data.credits.used)} of ${num(data.credits.granted)} used (${data.credits.percentUsed}%)`} />
            {data.credits.warning === 'out' && <Notice tone="error">Out of credits. The bot has stopped replying; messages still arrive in the shop&apos;s inbox.</Notice>}
            {data.credits.warning === 'low' && <Notice tone="warn">Over 80% of this month&apos;s credits are used.</Notice>}
            <h2 style={{ marginTop: 8 }}>AI replies, last 30 days</h2>
            <DayChart days={data.usage} value={(d) => d.aiReplies} label="AI replies" span={30} />
          </section>
        </div>

        <div className="grid2">
          <section className="card pad" aria-label="Pages">
            <h2>Facebook pages and channels</h2>
            {data.channels.length === 0 ? (
              <Empty>No pages connected.</Empty>
            ) : (
              data.channels.map((c) => {
                const s = CHANNEL_STATUS[c.status] ?? { label: c.status, tone: 'amber' as const };
                return (
                  <div key={c.id} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                    <strong>{c.name}</strong>
                    <span className="sub">{c.type === 'facebook_page' ? 'Facebook page' : c.type}</span>
                    <span style={{ marginLeft: 'auto' }}>
                      <Pill tone={s.tone}>{s.label}</Pill>
                    </span>
                    {c.lastError && <div className="sub" style={{ width: '100%', color: 'var(--red)' }}>{c.lastError}</div>}
                  </div>
                );
              })
            )}
            <h2 style={{ marginTop: 8 }}>Knowledge base</h2>
            {Object.keys(data.knowledge).length === 0 ? (
              <span className="muted">No sources added.</span>
            ) : (
              <div className="chips">
                {Object.entries(data.knowledge).map(([status, n]) => (
                  <Pill key={status} tone={status === 'ready' ? 'green' : status === 'failed' ? 'red' : 'amber'}>
                    {n} {status}
                  </Pill>
                ))}
              </div>
            )}
          </section>

          <section className="card pad" aria-label="Team">
            <h2>Shop team</h2>
            {data.members.map((m) => (
              <div key={m.userId} style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <strong>{m.name ?? 'No name'}</strong>
                <span className="sub">{m.email ?? 'No email (Facebook sign-in)'}</span>
                <span style={{ marginLeft: 'auto' }}>
                  <Pill tone={m.role === 'owner' ? 'brand' : undefined}>{m.role}</Pill>
                </span>
              </div>
            ))}
            {data.subscriptions.length > 0 && (
              <>
                <h2 style={{ marginTop: 8 }}>Subscriptions</h2>
                {data.subscriptions.map((s) => (
                  <div key={s.id} className="sub">
                    {s.status} · {date(s.currentPeriodStart)} to {date(s.currentPeriodEnd)}
                    {s.gateway ? ` · ${s.gateway}` : ''}
                  </div>
                ))}
              </>
            )}
          </section>
        </div>

        {me.can('audit.read') && (
          <section className="card pad" aria-label="Recent admin activity">
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <h2>Recent Agently team activity on this shop</h2>
              <a href={`/audit?workspaceId=${t.id}`} style={{ marginLeft: 'auto', fontSize: 13 }}>
                Full audit log
              </a>
            </div>
            {audit.data?.entries.length ? (
              audit.data.entries.map((e) => (
                <div key={e.id} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 13 }}>
                  <span className="muted" style={{ minWidth: 120 }}>
                    {dateTime(e.createdAt)}
                  </span>
                  <strong>{e.actor.name}</strong>
                  <span>{actionLabel(e.action)}</span>
                </div>
              ))
            ) : (
              <span className="muted">{audit.loading ? 'Loading…' : 'Nothing yet.'}</span>
            )}
          </section>
        )}
      </div>
      {dialog && (
        <TenantActionDialog
          action={dialog}
          tenant={{ id: t.id, name: t.name, status: t.status, trialEndsAt: t.trialEndsAt, planKey: t.plan?.key }}
          onClose={() => setDialog(undefined)}
          onDone={(m) => {
            setDialog(undefined);
            setDone(m);
            reload();
            audit.reload();
          }}
        />
      )}
    </>
  );
}
