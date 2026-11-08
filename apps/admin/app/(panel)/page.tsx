'use client';

import { useAdmin } from '@/components/Shell';
import { Loading, Notice, Stat, TopBar } from '@/components/ui';
import { useLoad } from '@/lib/api';
import { bdt, num, usd } from '@/lib/format';
import type { Overview } from '@/lib/types';

export default function OverviewPage() {
  const me = useAdmin();
  const { data, error, loading } = useLoad<Overview>(me.can('usage.read') ? '/overview' : null);

  return (
    <>
      <TopBar title="Overview">
        {me.can('tenants.read') && (
          <a className="btn" href="/tenants">
            All tenants
          </a>
        )}
      </TopBar>
      <div className="content">
        {error && <Notice tone="error">{error}</Notice>}
        {loading && !data && <Loading />}
        {data && (
          <>
            <section aria-label="Shops" className="stats">
              <Stat label="Active shops" value={num(data.tenants.active)} />
              <Stat label="On trial" value={num(data.tenants.trial)} />
              <Stat label="Out of AI credits" value={num(data.tenants.outOfCredits)} tone={data.tenants.outOfCredits ? 'bad' : undefined} />
              <Stat label="Payment overdue" value={num(data.tenants.pastDue)} tone={data.tenants.pastDue ? 'warn' : undefined} />
              <Stat label="Suspended" value={num(data.tenants.suspended)} />
            </section>
            <section aria-label="Money" className="stats">
              <Stat label="Revenue per month (BDT)" value={bdt(data.mrr?.bdt)} note="Paid plans on active shops in Bangladesh" />
              <Stat label="Revenue per month (USD)" value={usd(data.mrr?.usd, 0)} note="Paid plans on active shops elsewhere" />
              <Stat label="AI cost this month" value={usd(data.aiCostThisMonthUsd)} note="What the model provider charges us" />
              <Stat label="New shops" value={num(data.signups.last7)} note={`Last 7 days · ${num(data.signups.last30)} in 30 days`} />
            </section>
            <h2 style={{ fontSize: 16 }}>Today (UTC)</h2>
            <section aria-label="Today" className="stats">
              <Stat label="Customer messages" value={num(data.today.customerMessages)} />
              <Stat label="AI replies" value={num(data.today.aiReplies)} />
              <Stat label="Handed to staff" value={num(data.today.handoffs)} />
              <Stat
                label="Failed AI calls"
                value={num(data.today.failedAiCalls)}
                note={`${(data.today.errorRate * 100).toFixed(1)}% of AI calls`}
                tone={data.today.errorRate > 0.05 ? 'bad' : data.today.failedAiCalls ? 'warn' : undefined}
              />
            </section>
            <p className="sub" style={{ margin: 0 }}>
              Online payments aren&apos;t live yet, so there are no failed payments to show. See <a href="/usage">AI usage</a> for cost by day, model and shop.
            </p>
          </>
        )}
      </div>
    </>
  );
}
