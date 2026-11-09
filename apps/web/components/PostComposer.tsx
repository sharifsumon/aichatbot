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
  /** 'button': one real button under the post (link post, website picture); 'links': all photos, links in the text. */
  const [style, setStyle] = useState<'button' | 'links'>('button');
  const [buttonType, setButtonType] = useState<'message' | 'order'>('message');
  const [pageUrl, setPageUrl] = useState('');
  const [messageButton, setMessageButton] = useState(true);
  const [orderOn, setOrderOn] = useState(true);
  const [orderTo, setOrderTo] = useState<'messenger' | 'website'>('messenger');
  const [orderUrl, setOrderUrl] = useState('');
  const useRealButton = style === 'button';
  const isUrl = (u: string) => /^https?:\/\/\S+$/i.test(u.trim());
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
    if (useRealButton && !isUrl(pageUrl)) return "Paste this product's page on your website, starting with https://. Facebook shows its picture above the button.";
    if (!useRealButton && orderOn && orderTo === 'website' && !isUrl(orderUrl)) return 'Paste the product page address on your website, starting with https://';
    const r = await api<{ post: FacebookPost }>(`${ws}/products/${product.id}/facebook-posts`, {
      method: 'POST',
      body: {
        channelId: page.id,
        message,
        photoUrls: photos,
        ...(useRealButton
          ? { realButton: { type: buttonType, pageUrl: pageUrl.trim(), orderTo } }
          : { messageButton, orderButton: !orderOn ? null : orderTo === 'messenger' ? { to: 'messenger' } : { to: 'website', url: orderUrl.trim() } }),
      },
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
      <fieldset style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 12, display: 'flex', flexDirection: 'column', gap: 8, margin: 0 }}>
        <legend style={{ fontSize: 13, fontWeight: 600, padding: '0 4px' }}>Buttons</legend>
        <div role="radiogroup" aria-label="Button style" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label className="check">
            <input type="radio" name="style" checked={style === 'button'} onChange={() => setStyle('button')} />
            A real button at the bottom of the post
          </label>
          <label className="check">
            <input type="radio" name="style" checked={style === 'links'} onChange={() => setStyle('links')} />
            Links in the text, keeping all the photos
          </label>
        </div>
        {style === 'button' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 26 }}>
            <input className="input" type="url" aria-label="This product's page on your website" placeholder="https://banggii.com/product/…" value={pageUrl} onChange={(e) => setPageUrl(e.target.value)} style={{ height: 34, fontSize: 13 }} />
            <small className="muted">Facebook allows one button per post, and only on a post that links to a web page. It shows this page&apos;s picture above the button, instead of the photos below.</small>
            <div role="radiogroup" aria-label="Which button" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label className="check">
                <input type="radio" name="button-type" checked={buttonType === 'message'} onChange={() => setButtonType('message')} />
                Send Message: opens Messenger with your bot
              </label>
              <label className="check">
                <input type="radio" name="button-type" checked={buttonType === 'order'} onChange={() => setButtonType('order')} />
                Order Now
              </label>
              {buttonType === 'order' && (
                <div role="radiogroup" aria-label="Order Now goes to" style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 26 }}>
                  <label className="check">
                    <input type="radio" name="order-to" checked={orderTo === 'messenger'} onChange={() => setOrderTo('messenger')} />
                    To Messenger: the bot takes the order
                  </label>
                  <label className="check">
                    <input type="radio" name="order-to" checked={orderTo === 'website'} onChange={() => setOrderTo('website')} />
                    To the page on my website
                  </label>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 26 }}>
            <label className="check">
              <input type="checkbox" checked={messageButton} onChange={(e) => setMessageButton(e.target.checked)} />
              💬 Message us: opens Messenger, and the bot starts on this product
            </label>
            <label className="check">
              <input type="checkbox" checked={orderOn} onChange={(e) => setOrderOn(e.target.checked)} />
              🛒 Order now
            </label>
            {orderOn && (
              <div role="radiogroup" aria-label="Order now goes to" style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 26 }}>
                <label className="check">
                  <input type="radio" name="order-to-link" checked={orderTo === 'messenger'} onChange={() => setOrderTo('messenger')} />
                  In Messenger: the bot takes the order (colour, size, address, payment)
                </label>
                <label className="check">
                  <input type="radio" name="order-to-link" checked={orderTo === 'website'} onChange={() => setOrderTo('website')} />
                  On my website
                </label>
                {orderTo === 'website' && (
                  <input className="input" type="url" aria-label="Product page on your website" placeholder="https://banggii.com/product/…" value={orderUrl} onChange={(e) => setOrderUrl(e.target.value)} style={{ height: 34, fontSize: 13 }} />
                )}
              </div>
            )}
            <small className="muted">The links are added at the end of the post.</small>
          </div>
        )}
      </fieldset>
      {useRealButton ? null : product.images.length > 0 ? (
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
