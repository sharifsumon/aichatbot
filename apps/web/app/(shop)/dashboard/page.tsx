'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useShop } from '@/components/Shell';
import { Loading, Meter, Notice, Pill, ShopStatusPill, Stat, Toggle, TopBar } from '@/components/ui';
import { useApi } from '@/lib/api';
import { Feed } from '@/components/Feed';
import { bdt, date, daysLeft, num } from '@/lib/format';

/** Home: what needs the shop today, the setup checklist, the bot switch and recent activity. */
export default function DashboardPage() {
  const { home: h, manager, ws, reloadHome, me } = useShop();
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  if (!h) {
    return (
      <>
        <TopBar title="Dashboard" />
        <div className="content">
          <Loading />
        </div>
      </>
    );
  }

  const steps = [
    { done: h.setup.pageConnected, title: 'Connect your Facebook page', note: 'The bot answers messages and comments on it.', href: '/settings?tab=pages', cta: 'Connect' },
    { done: h.setup.products > 0, title: 'Add your products', note: 'Prices, colours, sizes and stock the bot can quote.', href: '/catalog', cta: 'Add products' },
    { done: h.setup.paymentNumbers, title: 'Add your bKash or Nagad number', note: 'So the bot can take payment in chat. Cash on delivery is on already.', href: '/settings?tab=payments', cta: 'Add numbers' },
    { done: h.setup.knowledgeSources > 0, title: 'Teach the bot about your shop', note: 'Delivery times, exchange policy, sizes: anything customers ask.', href: '/knowledge', cta: 'Add knowledge' },
    { done: h.setup.agentLive, title: 'Switch the bot on', note: 'It starts replying to new messages straight away.', href: '/agent', cta: 'Open bot settings' },
  ];
  const doneCount = steps.filter((s) => s.done).length;

  async function setLive(live: boolean) {
    setBusy(true);
    setError(undefined);
    try {
      await api(`${ws}/agent`, { method: 'PATCH', body: { status: live ? 'live' : 'paused' } });
      reloadHome();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const live = h.agent?.status === 'live';
  return (
    <>
      <TopBar title={`Hello, ${me.user.name.split(' ')[0]}`}>
        <ShopStatusPill status={h.shop.status} trialDaysLeft={daysLeft(h.shop.trialEndsAt)} />
        {manager && h.agent && <Toggle checked={live} disabled={busy} onChange={setLive} label={live ? `${h.agent.name} is replying` : `${h.agent.name} is off`} />}
      </TopBar>
      <div className="content">
        {error && <Notice tone="error">{error}</Notice>}
        <div className="stats">
          <Link className="stat" href="/inbox?filter=human">
            <span>Chats that need you</span>
            <strong className="num" style={h.stats.needsYou ? { color: 'var(--red)' } : undefined}>
              {num(h.stats.needsYou)}
            </strong>
            <small>{num(h.stats.aiHandling)} open chats the bot is handling</small>
          </Link>
          <Link className="stat" href="/orders">
            <span>Orders today</span>
            <strong className="num">{num(h.stats.ordersToday)}</strong>
            <small>{num(h.stats.ordersThisMonth)} this month</small>
          </Link>
          <Link className="stat" href="/orders?payment=pending_verification">
            <span>Payments to check</span>
            <strong className="num" style={h.stats.awaitingPayment ? { color: 'var(--amber)' } : undefined}>
              {num(h.stats.awaitingPayment)}
            </strong>
            <small>bKash and Nagad transaction IDs</small>
          </Link>
          <Stat label="Revenue this month" value={bdt(h.stats.revenueThisMonth)} note="Orders not cancelled or returned" />
        </div>

        <div className="grid2">
          {doneCount < steps.length ? (
            <section className="card pad" aria-label="Setup">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <h2>Get your bot ready</h2>
                <span className="sub" style={{ marginLeft: 'auto' }}>
                  {doneCount} of {steps.length} done
                </span>
              </div>
              <div className="steps">
                {steps.map((s, i) => (
                  <div key={s.title} className={`step${s.done ? ' done' : ''}`}>
                    <span className="dot">{s.done ? '✓' : i + 1}</span>
                    <div>
                      <strong>{s.title}</strong>
                      <span>{s.note}</span>
                    </div>
                    {!s.done && manager && (
                      <Link className="btn sm" href={s.href}>
                        {s.cta}
                      </Link>
                    )}
                  </div>
                ))}
              </div>
            </section>
          ) : (
            <section className="card pad" aria-label="Pages">
              <h2>Your pages</h2>
              {h.channels.map((c) => (
                <div key={c.id} className="page-row">
                  <div>
                    <strong>{c.name}</strong>
                    {c.lastError && <span className="sub">{c.lastError}</span>}
                  </div>
                  <Pill tone={c.status === 'connected' ? 'green' : 'amber'}>{c.status === 'connected' ? 'Connected' : 'Needs reconnecting'}</Pill>
                </div>
              ))}
            </section>
          )}

          <section className="card pad" aria-label="AI credits">
            <h2>AI replies this month</h2>
            <Meter used={h.credits.used} total={h.credits.granted} label={`${num(h.credits.used)} of ${num(h.credits.granted)} used`} />
            <span className="sub">
              {num(h.credits.remaining)} left · resets {date(h.credits.periodEnd)}
            </span>
            {h.credits.warning === 'low' && <Notice tone="warn">Over 80% of this month&apos;s replies are used.</Notice>}
            {h.channels.some((c) => c.status === 'token_expired' || c.status === 'error') && (
              <Notice tone="warn">
                A page needs reconnecting, so the bot can&apos;t reply there. <Link href="/settings?tab=pages">Reconnect it</Link>
              </Notice>
            )}
          </section>
        </div>

        <section className="card pad" aria-label="Recent activity">
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <h2>Recent activity</h2>
            <Link href="/activity" style={{ marginLeft: 'auto', fontSize: 13 }}>
              See all
            </Link>
          </div>
          <Feed items={h.activity} />
        </section>
      </div>
    </>
  );
}
