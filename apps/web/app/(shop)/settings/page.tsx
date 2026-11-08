'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { BillingTab, PagesTab, PaymentsTab, ShopTab, TeamTab } from '@/components/SettingsTabs';
import { useShop } from '@/components/Shell';
import { Loading, Notice } from '@/components/ui';

const TABS = [
  { key: 'shop', label: 'Shop profile' },
  { key: 'pages', label: 'Facebook pages' },
  { key: 'payments', label: 'Payments and delivery' },
  { key: 'team', label: 'Team' },
  { key: 'subscription', label: 'Subscription' },
] as const;

function Settings() {
  const { manager } = useShop();
  const tab = useSearchParams().get('tab') ?? 'shop';

  return (
    <>
      <header className="top" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
        <h1>Settings</h1>
        <nav className="tabs" aria-label="Settings sections">
          {TABS.map((t) => (
            <Link key={t.key} className={`tab${tab === t.key ? ' on' : ''}`} href={`/settings?tab=${t.key}`} aria-current={tab === t.key ? 'page' : undefined}>
              {t.label}
            </Link>
          ))}
        </nav>
      </header>
      <div className="content narrow">
        {!manager ? (
          <Notice tone="info">Only the shop owner or an admin can change settings.</Notice>
        ) : tab === 'pages' ? (
          <PagesTab />
        ) : tab === 'payments' ? (
          <PaymentsTab />
        ) : tab === 'team' ? (
          <TeamTab />
        ) : tab === 'subscription' ? (
          <BillingTab />
        ) : (
          <ShopTab />
        )}
      </div>
    </>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Settings />
    </Suspense>
  );
}
