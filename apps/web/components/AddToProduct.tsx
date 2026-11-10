'use client';

import { useEffect, useState } from 'react';
import { useShop } from '@/components/Shell';
import { Dialog, Empty, Loading } from '@/components/ui';
import { qs, useApi } from '@/lib/api';
import type { Product } from '@/lib/types';

/** Adds a generated photo (as the last photo) or video (as the product video) to an existing product. */
export function AddToProduct({ url, kind = 'photo', onClose, onDone }: { url: string; kind?: 'photo' | 'video'; onClose: () => void; onDone: (p: Product) => void }) {
  const { ws } = useShop();
  const api = useApi();
  const [q, setQ] = useState('');
  const [products, setProducts] = useState<Product[]>();
  const [chosen, setChosen] = useState<Product>();

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      api<{ products: Product[] }>(`${ws}/products${qs({ q: q.trim(), limit: 30 })}`)
        .then((r) => live && setProducts(r.products))
        .catch(() => live && setProducts([]));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [api, ws, q]);

  return (
    <Dialog
      title="Add to a product"
      submitLabel={kind === 'video' ? 'Add video' : 'Add photo'}
      onClose={onClose}
      onSubmit={async () => {
        if (!chosen) return 'Choose a product';
        // Read it fresh, so nothing changed since the list loaded is lost.
        const { product: p } = await api<{ product: Product }>(`${ws}/products/${chosen.id}`);
        if (kind === 'photo' && p.images.length >= 10) return `${p.title} already has 10 photos. Remove one in the catalog first.`;
        if (kind === 'photo' && p.images.some((i) => i.url === url)) return `${p.title} already has this photo.`;
        if (kind === 'video' && p.videoUrl && !window.confirm(`${p.title} already has a video. Replace it?`)) return 'Kept the current video.';
        await api(`${ws}/products/${p.id}`, {
          method: 'PUT',
          body: {
            title: p.title,
            code: p.code,
            description: p.description,
            price: p.price,
            images: kind === 'photo' ? [...p.images, { url, color: '' }] : p.images,
            videoUrl: kind === 'video' ? url : p.videoUrl,
            status: p.status,
            variants: p.variants.map((v) => ({ color: v.color, size: v.size, stock: v.stock, price: v.price })),
          },
        });
        onDone(p);
      }}
    >
      <label className="field">
        <span className="sr">Search products</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or code…" autoFocus />
      </label>
      <div className="plist" role="listbox" aria-label="Products">
        {!products && <Loading />}
        {products?.length === 0 && <Empty>No products found.</Empty>}
        {products?.map((p) => (
          <button key={p.id} type="button" role="option" aria-selected={chosen?.id === p.id} className={chosen?.id === p.id ? 'on' : ''} onClick={() => setChosen(p)}>
            {p.imageUrl ? <img src={p.imageUrl} alt="" /> : <span className="noimg" />}
            <span>
              <strong style={{ display: 'block', fontSize: 14 }}>{p.title}</strong>
              <span className="sub">
                {p.code} · {p.images.length} photo{p.images.length === 1 ? '' : 's'}
              </span>
            </span>
          </button>
        ))}
      </div>
    </Dialog>
  );
}
