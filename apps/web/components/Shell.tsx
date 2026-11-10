'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Icon } from '@/components/icons';
import { Avatar, Loading, Notice } from '@/components/ui';
import { useApi, useLoad } from '@/lib/api';
import { daysLeft } from '@/lib/format';
import { MANAGERS, type Home, type Me, type Shop } from '@/lib/types';

const SHOP_KEY = 'agently_shop';

interface ShopContext {
  me: Me;
  shop: Shop;
  /** Owner or admin: can change settings, the catalog, the bot and the team. */
  manager: boolean;
  /** Prefix for this shop's API routes. */
  ws: string;
  home: Home | undefined;
  reloadHome: () => void;
  reloadMe: () => void;
}

const Ctx = createContext<ShopContext | null>(null);

export function useShop(): ShopContext {
  const c = useContext(Ctx);
  if (!c) throw new Error('useShop outside Shell');
  return c;
}

/** Remembers which shop a person with several shops last opened. */
export function rememberShop(id: string) {
  try {
    localStorage.setItem(SHOP_KEY, id);
  } catch {
    /* private mode */
  }
}

function savedShop(): string | null {
  try {
    return localStorage.getItem(SHOP_KEY);
  } catch {
    return null;
  }
}

const NAV: { href: string; label: string; icon: keyof typeof Icon; managers?: boolean; badge?: (h: Home) => number }[] = [
  { href: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
  { href: '/inbox', label: 'Inbox', icon: 'inbox', badge: (h) => h.stats.needsYou },
  { href: '/orders', label: 'Orders', icon: 'orders', badge: (h) => h.stats.awaitingPayment },
  { href: '/catalog', label: 'Product Catalog', icon: 'catalog' },
  { href: '/model-images', label: 'Images with models', icon: 'models', managers: true },
  { href: '/model-videos', label: 'Videos with models', icon: 'video', managers: true },
  { href: '/comments', label: 'Comments', icon: 'comments' },
  { href: '/agent', label: 'Chat Agent', icon: 'agent', managers: true },
  { href: '/knowledge', label: 'Knowledge base', icon: 'knowledge', managers: true },
  { href: '/activity', label: 'Recent Activity', icon: 'activity' },
];

export function Shell({ children }: { children: ReactNode }) {
  const api = useApi();
  const router = useRouter();
  const path = usePathname();
  const meLoad = useLoad<Me>('/me');
  const [open, setOpen] = useState(false);
  const me = meLoad.data;

  const shop = useMemo(() => {
    if (!me?.workspaces.length) return undefined;
    const want = savedShop();
    return me.workspaces.find((w) => w.id === want) ?? me.workspaces[0]!;
  }, [me]);

  useEffect(() => {
    if (me && !me.workspaces.length) router.replace('/start');
  }, [me, router]);

  const homeLoad = useLoad<Home>(shop ? `/workspaces/${shop.id}/home` : null);
  const { reload: reloadHome } = homeLoad;
  // Keep the badges fresh while the dashboard is open.
  useEffect(() => {
    const t = setInterval(reloadHome, 60_000);
    return () => clearInterval(t);
  }, [reloadHome]);
  useEffect(() => setOpen(false), [path]);

  const signOut = useCallback(async () => {
    await api('/logout', { method: 'POST' }).catch(() => undefined);
    window.location.href = '/';
  }, [api]);

  if (!me || !shop) {
    return <div className="auth">{meLoad.error ? <Notice tone="error">{meLoad.error}</Notice> : <Loading />}</div>;
  }

  const manager = MANAGERS.includes(shop.role);
  const h = homeLoad.data;
  const ctx: ShopContext = { me, shop, manager, ws: `/workspaces/${shop.id}`, home: h, reloadHome, reloadMe: meLoad.reload };
  const trialLeft = h?.shop.status === 'trial' ? daysLeft(h.shop.trialEndsAt) : null;

  return (
    <Ctx.Provider value={ctx}>
      <div className="app">
        <nav className={`side${open ? ' open' : ''}`} aria-label="Main">
          <div className="side-in">
          <Link className="brand" href="/dashboard">
            <Icon.logo />
            Agently
          </Link>
          <button type="button" className="icon-btn menu-btn" aria-expanded={open} aria-label="Menu" onClick={() => setOpen((o) => !o)}>
            <Icon.menu />
          </button>
          <div className="navs">
            {me.workspaces.length > 1 ? (
              <select
                className="shop-pick"
                aria-label="Shop"
                value={shop.id}
                onChange={(e) => {
                  rememberShop(e.target.value);
                  window.location.href = '/dashboard';
                }}
              >
                {me.workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            ) : (
              <div className="shop-name">{shop.name}</div>
            )}
            <div className="grp">MAIN</div>
            {NAV.filter((n) => !n.managers || manager).map((n) => {
              const I = Icon[n.icon];
              const count = h && n.badge ? n.badge(h) : 0;
              const on = path === n.href || path.startsWith(`${n.href}/`);
              return (
                <Link key={n.href} className={`nav${on ? ' on' : ''}`} href={n.href} aria-current={on ? 'page' : undefined}>
                  <I />
                  <span>{n.label}</span>
                  {count > 0 && <span className="badge">{count > 99 ? '99+' : count}</span>}
                </Link>
              );
            })}
            {manager && (
              <>
                <div className="grp">SYSTEM</div>
                <Link className={`nav${path.startsWith('/settings') ? ' on' : ''}`} href="/settings">
                  <Icon.settings />
                  <span>Settings</span>
                </Link>
              </>
            )}
          </div>
          <div className="side-foot">
            {h?.agent && (
              <Link className="bot-line" href={manager ? '/agent' : '/dashboard'}>
                <Icon.bot />
                <span>
                  {h.agent.name} (your bot) · {h.agent.status === 'live' ? 'On' : h.agent.status === 'paused' ? 'Paused' : 'Off'}
                </span>
              </Link>
            )}
            <div className="me">
              <Avatar name={me.user.name} size={36} />
              <div>
                <strong>{me.user.name}</strong>
                <span className="sub">{me.user.email ?? `${shop.role[0]!.toUpperCase()}${shop.role.slice(1)}`}</span>
              </div>
              <button type="button" className="icon-btn" aria-label="Sign out" title="Sign out" onClick={signOut}>
                <Icon.logout />
              </button>
            </div>
          </div>
          </div>
        </nav>
        <div className="main">
          {h?.shop.status === 'suspended' && (
            <div className="banner red" role="alert">
              <strong>Your shop is suspended.</strong> {h.shop.suspendedReason} The bot is not replying. Contact Agently support to sort this out.
            </div>
          )}
          {h && h.shop.status !== 'suspended' && h.credits.warning === 'out' && (
            <div className="banner red" role="alert">
              <strong>You are out of AI credits for this month.</strong> The bot has stopped replying; messages still arrive in your inbox.
              {manager && <Link href="/settings?tab=subscription">See your plan</Link>}
            </div>
          )}
          {h && h.shop.status === 'trial' && trialLeft === 0 && (
            <div className="banner amber">
              <strong>Your free trial has ended.</strong> Choose a plan to keep the bot replying.
              {manager && <Link href="/settings?tab=subscription">Choose a plan</Link>}
            </div>
          )}
          {children}
        </div>
      </div>
    </Ctx.Provider>
  );
}
