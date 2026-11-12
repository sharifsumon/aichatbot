'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Icon } from '@/components/icons';
import { MediaPanel, type MediaKind } from '@/components/MediaPanel';
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
  /** Opens the Images or Videos panel next to the menu. */
  openMedia: (kind: MediaKind) => void;
  /** Where the panel's "Add to post" sends picked media, if the open page takes any. */
  mediaTarget: MediaTarget | null;
  setMediaTarget: (t: MediaTarget | null) => void;
}

/** A page that can take photos or a video picked in the media panel. */
export interface MediaTarget {
  label: string;
  addPhotos?: (urls: string[]) => void;
  addVideo?: (url: string) => void;
}

const Ctx = createContext<ShopContext | null>(null);

export function useShop(): ShopContext {
  const c = useContext(Ctx);
  if (!c) throw new Error('useShop outside Shell');
  return c;
}

/** Lets the open page receive media picked in the Images or Videos panel while it is mounted. */
export function useMediaTarget(target: MediaTarget | null) {
  const { setMediaTarget } = useShop();
  useEffect(() => {
    setMediaTarget(target);
    return () => setMediaTarget(null);
  }, [target, setMediaTarget]);
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

type NavItem = { label: string; icon: keyof typeof Icon; managers?: boolean; badge?: (h: Home) => number } & (
  | { href: string; panel?: undefined; also?: string }
  | { panel: MediaKind; href: string; also?: undefined }
);

/** The always-collapsed menu. Images and Videos open a panel next to it; the rest open their page. */
const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
  { href: '/inbox', label: 'Inbox', icon: 'inbox', badge: (h) => h.stats.needsYou },
  { href: '/orders', label: 'Orders', icon: 'orders', badge: (h) => h.stats.awaitingPayment },
  { href: '/catalog', label: 'Catalog', icon: 'catalog' },
  { href: '/page-posts', label: 'Page posts', icon: 'pagePost', managers: true },
  { panel: 'images', href: '/model-images', label: 'Images', icon: 'images', managers: true },
  { panel: 'videos', href: '/model-videos', label: 'Videos', icon: 'video', managers: true },
  { href: '/comments', label: 'Comments', icon: 'comments' },
  { href: '/agent', label: 'Chat Agent', icon: 'agent', managers: true },
  { href: '/knowledge', label: 'Knowledge', icon: 'knowledge', managers: true },
  { href: '/activity', label: 'Activity', icon: 'activity' },
];

export function Shell({ children }: { children: ReactNode }) {
  const api = useApi();
  const router = useRouter();
  const path = usePathname();
  const meLoad = useLoad<Me>('/me');
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<MediaKind | null>(null);
  const [mediaTarget, setMediaTarget] = useState<MediaTarget | null>(null);
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
  const openMedia = useCallback((kind: MediaKind) => {
    setPanel(kind);
    setOpen(false);
  }, []);
  // Escape closes the panel.
  useEffect(() => {
    if (!panel) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPanel(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel]);

  const signOut = useCallback(async () => {
    await api('/logout', { method: 'POST' }).catch(() => undefined);
    window.location.href = '/';
  }, [api]);

  if (!me || !shop) {
    return <div className="auth">{meLoad.error ? <Notice tone="error">{meLoad.error}</Notice> : <Loading />}</div>;
  }

  const manager = MANAGERS.includes(shop.role);
  const h = homeLoad.data;
  const ctx: ShopContext = { me, shop, manager, ws: `/workspaces/${shop.id}`, home: h, reloadHome, reloadMe: meLoad.reload, openMedia, mediaTarget, setMediaTarget };
  const trialLeft = h?.shop.status === 'trial' ? daysLeft(h.shop.trialEndsAt) : null;
  const items = NAV.filter((n) => !n.managers || manager);

  return (
    <Ctx.Provider value={ctx}>
      <div className="app">
        <header className="appbar">
          <button type="button" className="icon-btn menu-btn" aria-expanded={open} aria-controls="main-menu" aria-label="Menu" onClick={() => setOpen((o) => !o)}>
            <Icon.menu />
          </button>
          <Link className="brand" href="/dashboard">
            <Icon.logo />
            Agently
          </Link>
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
          <div className="appbar-right">
            {h?.agent && (
              <Link className="bot-line" href={manager ? '/agent' : '/dashboard'} title="Your bot">
                <span className={`dot ${h.agent.status === 'live' ? 'on' : ''}`} aria-hidden="true" />
                <span>
                  {h.agent.name} · {h.agent.status === 'live' ? 'On' : h.agent.status === 'paused' ? 'Paused' : 'Off'}
                </span>
              </Link>
            )}
            <div className="me" title={me.user.email ?? undefined}>
              <Avatar name={me.user.name} size={32} />
              <strong>{me.user.name}</strong>
            </div>
            <button type="button" className="icon-btn" aria-label="Sign out" title="Sign out" onClick={signOut}>
              <Icon.logout />
            </button>
          </div>
        </header>
        <div className="frame">
          <nav id="main-menu" className={`rail${open ? ' open' : ''}`} aria-label="Main">
            {items.map((n) => {
              const I = Icon[n.icon];
              const count = h && n.badge ? n.badge(h) : 0;
              const here = path === n.href || path.startsWith(`${n.href}/`);
              const badge = count > 0 && <span className="badge">{count > 99 ? '99+' : count}</span>;
              if (n.panel) {
                const on = panel === n.panel || (!panel && here);
                return (
                  <button
                    key={n.label}
                    type="button"
                    className={`ri${on ? ' on' : ''}`}
                    aria-expanded={panel === n.panel}
                    aria-controls="media-panel"
                    onClick={() => (panel === n.panel ? setPanel(null) : openMedia(n.panel))}
                  >
                    <I />
                    <span>{n.label}</span>
                  </button>
                );
              }
              return (
                <Link
                  key={n.href}
                  className={`ri${here ? (panel ? ' cur' : ' on') : ''}`}
                  href={n.href}
                  aria-current={here ? 'page' : undefined}
                  onClick={() => setPanel(null)}
                >
                  <I />
                  <span>{n.label}</span>
                  {badge}
                </Link>
              );
            })}
            {manager && (
              <>
                <div className="rail-grp">SYSTEM</div>
                <Link
                  className={`ri${path.startsWith('/settings') ? (panel ? ' cur' : ' on') : ''}`}
                  href="/settings"
                  aria-current={path.startsWith('/settings') ? 'page' : undefined}
                  onClick={() => setPanel(null)}
                >
                  <Icon.settings />
                  <span>Settings</span>
                </Link>
              </>
            )}
          </nav>
          {panel && <MediaPanel kind={panel} onClose={() => setPanel(null)} />}
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
      </div>
    </Ctx.Provider>
  );
}
