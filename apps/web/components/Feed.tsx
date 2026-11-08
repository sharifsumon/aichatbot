'use client';

import Link from 'next/link';
import { ago } from '@/lib/format';
import type { Activity } from '@/lib/types';

/** The shop's activity feed; entries about an order or a chat link to it. */
export function Feed({ items }: { items: Activity[] }) {
  if (!items.length) return <span className="muted">Nothing yet. New orders, handovers and changes show up here.</span>;
  return (
    <div className="feed">
      {items.map((a) => {
        const link = typeof a.data.orderId === 'string' ? `/orders?open=${a.data.orderId}` : typeof a.data.conversationId === 'string' ? `/inbox?c=${a.data.conversationId}` : undefined;
        return (
          <div key={a.id}>
            <time dateTime={a.createdAt}>{ago(a.createdAt)}</time>
            {link ? <Link href={link}>{a.text}</Link> : <span>{a.text}</span>}
          </div>
        );
      })}
    </div>
  );
}
