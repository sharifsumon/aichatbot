'use client';

import { useMemo, useState } from 'react';
import { useShop } from '@/components/Shell';
import { Dialog, Notice } from '@/components/ui';
import { useApi, useLoad } from '@/lib/api';
import { bdt, dateTime } from '@/lib/format';
import type { FacebookPost, Product } from '@/lib/types';

/** Same limits as the API. */
const MAX_TEXT = 5000;
const MAX_PHOTOS = 10;

/**
 * The product details for a post: name, price, colours and sizes in stock,
 * code and description. The shop can edit the result before posting.
 */
export function productDetailsText(p: Product): string {
  const prices = p.variants.map((v) => Number(v.price ?? p.price));
  const low = Math.min(...prices, Number(p.price));
  const high = Math.max(...prices, Number(p.price));
  const inStock = p.variants.filter((v) => v.stock > 0);
  // Offer only what can be bought; when everything is sold out, list it all.
  const pool = inStock.length ? inStock : p.variants;
  const colors = [...new Set(pool.map((v) => v.color).filter(Boolean))];
  const sizes = p.sizes.filter((s) => pool.some((v) => v.size === s));
  return [
    `🛍️ ${p.title}`,
    `💰 Price: ${low === high ? bdt(low) : `${bdt(low)} – ${bdt(high)}`}`,
    colors.length ? `🎨 Colours: ${colors.join(', ')}` : '',
    sizes.length ? `📏 Sizes: ${sizes.join(', ')}` : '',
    `🔖 Code: ${p.code}`,
    p.description ? `\n${p.description}` : '',
    '\n📩 Message us to order.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Writes a Facebook post for a product (your own words plus its details and photos) and publishes it on the page. */
export function PostComposer({ product, onClose, onPosted }: { product: Product; onClose: () => void; onPosted: (post: FacebookPost) => void }) {
  const { ws, home } = useShop();
  const api = useApi();
  const pages = useMemo(() => (home?.channels ?? []).filter((c) => c.type === 'facebook_page' && c.status !== 'disconnected'), [home]);
  const [channelId, setChannelId] = useState(() => pages.find((p) => p.status === 'connected')?.id ?? pages[0]?.id ?? '');
  const [intro, setIntro] = useState('');
  const [details, setDetails] = useState(() => productDetailsText(product));
  const [photos, setPhotos] = useState<string[]>(() => product.images.slice(0, MAX_PHOTOS).map((i) => i.url));
  const past = useLoad<{ posts: FacebookPost[] }>(`${ws}/products/${product.id}/facebook-posts`);

  const message = [intro.trim(), details.trim()].filter(Boolean).join('\n\n');
  const page = pages.find((p) => p.id === channelId);

  function toggle(url: string) {
    setPhotos((cur) => (cur.includes(url) ? cur.filter((u) => u !== url) : cur.length >= MAX_PHOTOS ? cur : [...product.images.map((i) => i.url).filter((u) => u === url || cur.includes(u))]));
  }

  async function submit(): Promise<string | void> {
    if (!page) return 'Connect your Facebook page in Settings first.';
    if (!message) return 'Write something for the post.';
    if (message.length > MAX_TEXT) return `The post is ${message.length} characters; keep it under ${MAX_TEXT}.`;
    const r = await api<{ post: FacebookPost }>(`${ws}/products/${product.id}/facebook-posts`, {
      method: 'POST',
      body: { channelId: page.id, message, photoUrls: photos },
    });
    onPosted(r.post);
    onClose();
  }

  return (
    <Dialog title={`Post ${product.title} on Facebook`} submitLabel={page ? `Post on ${page.name}` : 'Post'} wide onClose={onClose} onSubmit={submit}>
      {pages.length === 0 && <Notice tone="warn">Connect your Facebook page in Settings first, then come back to post.</Notice>}
      {page && page.status !== 'connected' && <Notice tone="warn">{page.name} needs to be reconnected in Settings before you can post.</Notice>}
      {pages.length > 1 && (
        <label className="field">
          Page
          <select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
            {pages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        Your text
        <textarea rows={3} value={intro} onChange={(e) => setIntro(e.target.value)} placeholder="New arrival! Limited stock, order today 🔥" autoFocus />
        <small>Shown at the top of the post, before the product details.</small>
      </label>
      <label className="field">
        Product details
        <textarea rows={8} value={details} onChange={(e) => setDetails(e.target.value)} />
        <small>
          Filled in from the catalog; edit anything you like.{' '}
          <button type="button" className="btn link" style={{ padding: 0, fontSize: 'inherit' }} onClick={() => setDetails(productDetailsText(product))}>
            Reset
          </button>
        </small>
      </label>
      {product.images.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            Photos <small className="muted">({photos.length} of {product.images.length} chosen)</small>
          </span>
          <div className="photos">
            {product.images.map((img, i) => {
              const on = photos.includes(img.url);
              return (
                <label key={img.url} className={`shot${on ? ' main' : ''}`} style={{ cursor: 'pointer' }}>
                  <div className="img">
                    <img src={img.url} alt={img.color ? `${img.color} photo` : `Photo ${i + 1}`} style={on ? undefined : { opacity: 0.4 }} />
                  </div>
                  <span className="check" style={{ fontSize: 12, padding: 6 }}>
                    <input type="checkbox" checked={on} onChange={() => toggle(img.url)} aria-label={`Include photo ${i + 1}`} />
                    {img.color || 'All colours'}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      ) : (
        <Notice tone="info">This product has no photos, so the post will be text only. Add photos in the product editor for a better post.</Notice>
      )}
      <small className="muted">
        {message.length} / {MAX_TEXT} characters. When customers comment on this post, the bot knows it is about {product.title}.
      </small>
      {past.data && past.data.posts.length > 0 && (
        <div style={{ fontSize: 13 }}>
          <strong>Posted before</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {past.data.posts.slice(0, 3).map((p) => (
              <li key={p.id}>
                <a href={p.url} target="_blank" rel="noreferrer">
                  {dateTime(p.createdAt)}
                </a>{' '}
                on {p.pageName}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Dialog>
  );
}
