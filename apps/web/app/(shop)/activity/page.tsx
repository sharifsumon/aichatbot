'use client';

import { useCallback, useEffect, useState } from 'react';
import { Feed } from '@/components/Feed';
import { useShop } from '@/components/Shell';
import { Loading, Notice, TopBar } from '@/components/ui';
import { qs, useApi } from '@/lib/api';
import type { Activity } from '@/lib/types';

/** Everything that happened in the shop: orders, handovers, settings, team. */
export default function ActivityPage() {
  const { ws } = useShop();
  const api = useApi();
  const [rows, setRows] = useState<Activity[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      try {
        const r = await api<{ activities: Activity[]; nextCursor: string | null }>(`${ws}/activities${qs({ cursor })}`);
        setRows((prev) => (cursor ? [...prev, ...r.activities] : r.activities));
        setNext(r.nextCursor);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [api, ws],
  );

  useEffect(() => {
    load();
  }, [load]);

  return (
    <>
      <TopBar title="Recent Activity" />
      <div className="content narrow">
        {error && <Notice tone="error">{error}</Notice>}
        <section className="card pad">
          {rows.length > 0 || !loading ? <Feed items={rows} /> : null}
          {loading && <Loading />}
          {next && !loading && (
            <div className="more">
              <button type="button" className="btn" onClick={() => load(next)}>
                Show more
              </button>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
