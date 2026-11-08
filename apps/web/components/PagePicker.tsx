'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loading, Notice, Pill } from '@/components/ui';
import { ApiError, useApi, useApiBase } from '@/lib/api';

interface FbPage {
  id: string;
  name: string;
  canMessage: boolean;
  connected: 'this_workspace' | 'other_workspace' | null;
}

/** The Facebook pages this person manages, with a Connect button on each. */
export function PagePicker({ shopId, onConnected }: { shopId: string; onConnected?: (name: string) => void }) {
  const api = useApi();
  const base = useApiBase();
  const [pages, setPages] = useState<FbPage[]>();
  const [reconnect, setReconnect] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();

  const load = useCallback(() => {
    setError(undefined);
    api<{ pages: FbPage[] }>(`/workspaces/${shopId}/facebook/pages`)
      .then((r) => setPages(r.pages))
      .catch((e: ApiError & { reconnect?: boolean }) => {
        if (e.status === 409) setReconnect(true);
        else setError(e.message);
        setPages([]);
      });
  }, [api, shopId]);

  useEffect(load, [load]);

  async function connect(p: FbPage) {
    setBusy(p.id);
    setError(undefined);
    try {
      await api(`/workspaces/${shopId}/facebook/pages/${p.id}/connect`, { method: 'POST' });
      onConnected?.(p.name);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  if (!pages) return <Loading what="Finding your pages" />;
  if (reconnect) {
    return (
      <Notice tone="warn">
        Facebook needs you to sign in again before we can list your pages.{' '}
        <a href={`${base}/auth/facebook`} style={{ color: 'inherit', fontWeight: 700 }}>
          Sign in with Facebook
        </a>
      </Notice>
    );
  }
  return (
    <div>
      {error && <Notice tone="error">{error}</Notice>}
      {pages.length === 0 && !error && (
        <Notice tone="info">
          We could not find any pages you manage. Make sure you are an admin of the page, and that you ticked it when Facebook asked which pages Agently can use.{' '}
          <a href={`${base}/auth/facebook`} style={{ color: 'inherit', fontWeight: 700 }}>
            Choose pages again
          </a>
        </Notice>
      )}
      {pages.map((p) => (
        <div key={p.id} className="page-row">
          <div>
            <strong>{p.name}</strong>
            {!p.canMessage && <span className="sub">You need permission to send messages as this page.</span>}
            {p.connected === 'other_workspace' && <span className="sub">Connected to another shop on Agently.</span>}
          </div>
          {p.connected === 'this_workspace' ? (
            <Pill tone="green">Connected</Pill>
          ) : (
            <button type="button" className="btn primary sm" disabled={!p.canMessage || p.connected === 'other_workspace' || !!busy} onClick={() => connect(p)}>
              {busy === p.id ? 'Connecting…' : 'Connect'}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
