'use client';

import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useApi, type ApiError } from '@/lib/api';
import { can, ROLE_LABEL, type Admin, type Permission } from '@/lib/types';
import { Loading, Notice } from './ui';

const Me = createContext<Admin | null>(null);

/** The signed-in Agently team member. */
export function useAdmin(): Admin & { can: (p: Permission) => boolean } {
  const admin = useContext(Me)!;
  return { ...admin, can: (p: Permission) => can(admin.role, p) };
}

const NAV: { href: string; label: string; perm?: Permission }[] = [
  { href: '/', label: 'Overview', perm: 'usage.read' },
  { href: '/tenants', label: 'Tenants', perm: 'tenants.read' },
  { href: '/conversations', label: 'Conversations', perm: 'conversations' },
  { href: '/usage', label: 'AI usage', perm: 'usage.read' },
  { href: '/plans', label: 'Plans' },
  { href: '/audit', label: 'Audit log', perm: 'audit.read' },
  { href: '/team', label: 'Team and roles', perm: 'team.manage' },
  { href: '/models', label: 'Model characters' },
  { href: '/settings', label: 'Platform settings', perm: 'settings.manage' },
];

export function Shell({ children }: { children: ReactNode }) {
  const api = useApi();
  const router = useRouter();
  const path = usePathname();
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    api<{ admin: Admin }>('/auth/me')
      .then((r) => setAdmin(r.admin))
      .catch((e: ApiError) => (e.status === 401 ? router.replace('/login') : setError(e.message)));
  }, [api, router]);

  async function signOut() {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    router.replace('/login');
  }

  if (error)
    return (
      <div className="content">
        <Notice tone="error">{error}</Notice>
      </div>
    );
  if (!admin) return <Loading />;

  const active = (href: string) => (href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`));

  return (
    <Me.Provider value={admin}>
      <div className="app">
        <nav className="side" aria-label="Admin">
          <a className="brand" href="/">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#A5B4FC" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z" />
            </svg>
            Agently
          </a>
          <span className="pill role">{ROLE_LABEL[admin.role]}</span>
          {NAV.filter((n) => !n.perm || can(admin.role, n.perm)).map((n) => (
            <a key={n.href} href={n.href} className={`nav${active(n.href) ? ' on' : ''}`} aria-current={active(n.href) ? 'page' : undefined}>
              {n.label}
            </a>
          ))}
          <div className="side-foot">
            <strong>{admin.name}</strong>
            <span>
              {ROLE_LABEL[admin.role]} · 2FA on
            </span>
            <div className="links">
              <a href="/account">Password</a>
              <button type="button" onClick={signOut}>
                Sign out
              </button>
            </div>
          </div>
        </nav>
        <main className="main">{children}</main>
      </div>
    </Me.Provider>
  );
}
