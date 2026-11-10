'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { PostComposer } from '@/components/PostComposer';
import { useShop } from '@/components/Shell';
import { Empty, Loading, Notice, Pill, SearchBox, TopBar } from '@/components/ui';
import { ApiError, qs, useApi, useUpload } from '@/lib/api';
import { shrinkImage } from '@/lib/image';
import { bdt, num } from '@/lib/format';
import type { FacebookPost, Product, ProductImage } from '@/lib/types';

/** Same limit as the API. */
const MAX_PHOTOS = 10;
/** Same limit as the API. */
const MAX_VIDEO_MB = 100;

const LOW_STOCK = 10;

export default function CatalogPage() {
  const { ws, manager, reloadHome } = useShop();
  const api = useApi();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Product[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<Product | 'new'>();
  const [done, setDone] = useState<string>();
  /** The product being written up as a Facebook post, and the last post made. */
  const [posting, setPosting] = useState<Product>();
  const [posted, setPosted] = useState<FacebookPost>();

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(undefined);
      try {
        const r = await api<{ products: Product[]; nextCursor: string | null }>(`${ws}/products${qs({ q, cursor })}`);
        setRows((prev) => (cursor ? [...prev, ...r.products] : r.products));
        setNext(r.nextCursor);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [api, ws, q],
  );

  useEffect(() => {
    load();
  }, [load]);

  const onSearch = useCallback((v: string) => setQ(v), []);
  const current = editing === 'new' ? undefined : editing;

  return (
    <>
      <TopBar title="Product Catalog">
        <SearchBox label="Search products" placeholder="Name or product code…" onSearch={onSearch} />
        {manager && (
          <button type="button" className="btn primary" onClick={() => setEditing('new')}>
            + Add product
          </button>
        )}
      </TopBar>
      <div className="content">
        {done && <Notice tone="ok">{done}</Notice>}
        {posted && (
          <Notice tone="ok">
            Posted on {posted.pageName}.{' '}
            <a href={posted.url} target="_blank" rel="noreferrer">
              View the post on Facebook
            </a>
          </Notice>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        <div className="catalog">
          <section className="products" aria-label="Products">
            {rows.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`product${current?.id === p.id ? ' on' : ''}`}
                onClick={() => manager && setEditing(p)}
                disabled={!manager}
                style={manager ? undefined : { cursor: 'default' }}
              >
                <div className="ph">
                  {p.imageUrl ? <img src={p.imageUrl} alt="" loading="lazy" /> : 'No photo'}
                  {p.images.length > 1 && <span className="count">{p.images.length} photos</span>}
                </div>
                <div className="info">
                  <div>
                    <strong>{p.title}</strong>
                    <StockPill p={p} />
                  </div>
                  <span className="sub">
                    {p.code}
                    {p.colors.length > 0 && ` · ${p.colors.length} colour${p.colors.length === 1 ? '' : 's'}`}
                    {p.sizes.length > 0 && ` · ${p.sizes.length} size${p.sizes.length === 1 ? '' : 's'}`}
                  </span>
                  <div>
                    <strong>{bdt(p.price)}</strong>
                    <span className="sub">{num(p.totalStock)} pcs</span>
                  </div>
                </div>
              </button>
            ))}
            {loading && <Loading />}
            {!loading && rows.length === 0 && (
              <div style={{ gridColumn: '1 / -1' }}>
                <Empty>{q ? 'No products match.' : manager ? 'No products yet. Add the things you sell, so the bot can quote prices and stock.' : 'No products yet.'}</Empty>
              </div>
            )}
            {next && !loading && (
              <div className="more" style={{ gridColumn: '1 / -1' }}>
                <button type="button" className="btn" onClick={() => load(next)}>
                  Show more
                </button>
              </div>
            )}
          </section>
          {editing && (
            <Editor
              key={current?.id ?? 'new'}
              product={current}
              onClose={() => setEditing(undefined)}
              onPost={current ? () => setPosting(current) : undefined}
              onSaved={(p, message) => {
                setDone(message);
                setEditing(p ?? undefined);
                load();
                reloadHome();
              }}
            />
          )}
        </div>
      </div>
      {/* Outside the editor: the composer is its own form, and forms can't nest. */}
      {posting && (
        <PostComposer
          product={posting}
          onClose={() => setPosting(undefined)}
          onPosted={(post) => {
            setDone(undefined);
            setPosted(post);
          }}
        />
      )}
    </>
  );
}

function StockPill({ p }: { p: Product }) {
  if (p.status === 'draft') return <Pill>Draft</Pill>;
  if (p.totalStock === 0) return <Pill tone="red">Out of stock</Pill>;
  if (p.totalStock < LOW_STOCK) return <Pill tone="amber">Low stock</Pill>;
  return <Pill tone="green">In stock</Pill>;
}

/** The colour × size grid, kept as two lists and a stock count per cell. */
interface Grid {
  colors: string[];
  sizes: string[];
  stock: Record<string, string>;
}

const cell = (c: string, s: string) => `${c.toLowerCase()}|${s.toLowerCase()}`;

function gridOf(p?: Product): Grid {
  if (!p) return { colors: [], sizes: [], stock: { [cell('', '')]: '0' } };
  const stock: Record<string, string> = {};
  for (const v of p.variants) stock[cell(v.color, v.size)] = String(v.stock);
  return { colors: p.colors, sizes: p.sizes, stock };
}

function variantsOf(g: Grid) {
  const colors = g.colors.length ? g.colors : [''];
  const sizes = g.sizes.length ? g.sizes : [''];
  return colors.flatMap((color) => sizes.map((size) => ({ color, size, stock: Math.max(0, Number.parseInt(g.stock[cell(color, size)] ?? '0', 10) || 0), price: null })));
}

function Editor({
  product,
  onClose,
  onSaved,
  onPost,
}: {
  product?: Product;
  onClose: () => void;
  onSaved: (p: Product | null, message: string) => void;
  /** Opens the Facebook post composer for the saved product. */
  onPost?: () => void;
}) {
  const { ws } = useShop();
  const api = useApi();
  const upload = useUpload();
  const file = useRef<HTMLInputElement>(null);
  const videoFile = useRef<HTMLInputElement>(null);
  const [videoUrl, setVideoUrl] = useState(product?.videoUrl ?? '');
  const [videoLink, setVideoLink] = useState('');
  const [videoUploading, setVideoUploading] = useState(false);
  const [title, setTitle] = useState(product?.title ?? '');
  const [code, setCode] = useState(product?.code ?? '');
  const [description, setDescription] = useState(product?.description ?? '');
  const [price, setPrice] = useState(product ? String(Number(product.price)) : '');
  const [images, setImages] = useState<ProductImage[]>(() => product?.images ?? []);
  const [photoLink, setPhotoLink] = useState('');
  /** The colour new photos are tagged with; '' for the whole product. */
  const [photoColor, setPhotoColor] = useState('');
  const [draft, setDraft] = useState(product?.status === 'draft');
  const [grid, setGrid] = useState<Grid>(() => gridOf(product));
  const [newColor, setNewColor] = useState('');
  const [newSize, setNewSize] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<{ done: number; of: number }>();
  const [error, setError] = useState<string>();

  const total = variantsOf(grid).reduce((n, v) => n + v.stock, 0);
  const setStock = (c: string, s: string, v: string) => setGrid((g) => ({ ...g, stock: { ...g.stock, [cell(c, s)]: v.replace(/\D/g, '') } }));

  function addColor() {
    const c = newColor.trim();
    if (!c || grid.colors.some((x) => x.toLowerCase() === c.toLowerCase())) return;
    setGrid((g) => {
      // The first colour takes over the stock entered without one.
      const stock = { ...g.stock };
      if (!g.colors.length) for (const s of g.sizes.length ? g.sizes : ['']) stock[cell(c, s)] = stock[cell('', s)] ?? '0';
      return { ...g, colors: [...g.colors, c], stock };
    });
    setNewColor('');
  }

  function addSize() {
    const s = newSize.trim();
    if (!s || grid.sizes.some((x) => x.toLowerCase() === s.toLowerCase())) return;
    setGrid((g) => {
      const stock = { ...g.stock };
      if (!g.sizes.length) for (const c of g.colors.length ? g.colors : ['']) stock[cell(c, s)] = stock[cell(c, '')] ?? '0';
      return { ...g, sizes: [...g.sizes, s], stock };
    });
    setNewSize('');
  }

  async function pickPhotos(files: File[]) {
    const room = MAX_PHOTOS - images.length;
    if (!files.length) return;
    if (room <= 0) {
      setError(`A product can have at most ${MAX_PHOTOS} photos. Remove one first.`);
      return;
    }
    const list = files.slice(0, room);
    setBusy(true);
    setError(undefined);
    try {
      for (let i = 0; i < list.length; i++) {
        setUploading({ done: i, of: list.length });
        const r = await upload<{ url: string }>(`${ws}/uploads/images`, await shrinkImage(list[i]!), 60_000);
        // A photo picked while one colour is chosen is tagged with it.
        setImages((cur) => [...cur, { url: r.url, color: photoColor }]);
      }
      if (files.length > room) setError(`Only ${room} more photo${room === 1 ? '' : 's'} fit; a product can have at most ${MAX_PHOTOS}.`);
    } catch (e) {
      setError((e as ApiError).status === 503 ? 'Photo uploads are not switched on yet. Paste a link to the photo instead.' : (e as Error).message);
    } finally {
      setBusy(false);
      setUploading(undefined);
      if (file.current) file.current.value = '';
    }
  }

  async function pickVideo(f: File | undefined) {
    if (!f) return;
    if (f.size > MAX_VIDEO_MB * 1024 * 1024) return setError(`A video can be at most ${MAX_VIDEO_MB} MB. Trim it or record a shorter one.`);
    setBusy(true);
    setVideoUploading(true);
    setError(undefined);
    try {
      // Large clips on a mobile connection take a while.
      const r = await upload<{ url: string }>(`${ws}/uploads/videos`, f, 10 * 60_000);
      setVideoUrl(r.url);
    } catch (e) {
      setError((e as ApiError).status === 503 ? 'Video uploads are not switched on yet. Paste a link to the video instead.' : (e as Error).message);
    } finally {
      setBusy(false);
      setVideoUploading(false);
      if (videoFile.current) videoFile.current.value = '';
    }
  }

  function addVideoLink() {
    const url = videoLink.trim();
    if (!/^https?:\/\/\S+$/.test(url)) return setError('Paste a full video link starting with https://');
    setVideoUrl(url);
    setVideoLink('');
    setError(undefined);
  }

  function addLink() {
    const url = photoLink.trim();
    if (!url) return;
    if (!/^https?:\/\/\S+$/.test(url)) return setError('Paste a full photo link starting with https://');
    if (images.length >= MAX_PHOTOS) return setError(`A product can have at most ${MAX_PHOTOS} photos. Remove one first.`);
    setImages((cur) => [...cur, { url, color: photoColor }]);
    setPhotoLink('');
    setError(undefined);
  }

  const photoColors = grid.colors;
  // Photos tagged with a colour that was removed from the grid become photos of the whole product.
  const shownImages = images.map((img) => (img.color && !photoColors.some((c) => c.toLowerCase() === img.color.toLowerCase()) ? { ...img, color: '' } : img));

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    const body = { title, code, description, price, images: shownImages, videoUrl: videoUrl || null, status: draft ? 'draft' : 'active', variants: variantsOf(grid) };
    try {
      const r = product
        ? await api<{ product: Product }>(`${ws}/products/${product.id}`, { method: 'PUT', body })
        : await api<{ product: Product }>(`${ws}/products`, { method: 'POST', body });
      onSaved(r.product, `${r.product.title} saved. The bot quotes the new price and stock from now on.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function archive() {
    if (!product || !window.confirm(`Remove ${product.title} from the catalog? Past orders keep it.`)) return;
    setBusy(true);
    try {
      await api(`${ws}/products/${product.id}`, { method: 'DELETE' });
      onSaved(null, `${product.title} removed from the catalog.`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const colors = grid.colors.length ? grid.colors : [''];
  const sizes = grid.sizes.length ? grid.sizes : [''];

  return (
    <form className="editor" aria-label={product ? `Edit ${product.title}` : 'Add a product'} onSubmit={save}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <h2>{product ? 'Edit product' : 'Add a product'}</h2>
        {product && onPost && product.status !== 'archived' && (
          <button type="button" className="btn sm" style={{ marginLeft: 'auto', marginRight: 8 }} onClick={onPost} disabled={busy}>
            Post to Facebook
          </button>
        )}
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose} style={product ? { marginLeft: 0 } : undefined}>
          ×
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>
          Photos <small className="muted">({shownImages.length} of {MAX_PHOTOS}; the first is the main photo)</small>
        </span>
        {shownImages.length > 0 && (
          <div className="photos">
            {shownImages.map((img, i) => (
              <div key={img.url} className={`shot${i === 0 ? ' main' : ''}`}>
                <div className="img">
                  <img src={img.url} alt={img.color ? `${img.color} photo` : 'Product photo'} />
                  {i === 0 && <span className="tag">Main</span>}
                  <button type="button" className="rm" aria-label={`Remove photo ${i + 1}`} onClick={() => setImages(shownImages.filter((_, j) => j !== i))}>
                    ×
                  </button>
                </div>
                {photoColors.length > 0 && (
                  <select aria-label={`Colour of photo ${i + 1}`} value={img.color} onChange={(e) => setImages(shownImages.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)))}>
                    <option value="">All colours</option>
                    {photoColors.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                )}
                {i > 0 && (
                  <button type="button" className="btn link" onClick={() => setImages([img, ...shownImages.filter((_, j) => j !== i)])}>
                    Make main
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          {photoColors.length > 0 && (
            <select className="input" aria-label="Colour for new photos" value={photoColor} onChange={(e) => setPhotoColor(e.target.value)} style={{ height: 34, fontSize: 13, flex: '0 1 150px' }}>
              <option value="">New photos: all colours</option>
              {photoColors.map((c) => (
                <option key={c} value={c}>
                  New photos: {c}
                </option>
              ))}
            </select>
          )}
          <button type="button" className="btn sm" onClick={() => file.current?.click()} disabled={busy || shownImages.length >= MAX_PHOTOS}>
            {uploading ? `Uploading ${uploading.done + 1} of ${uploading.of}…` : '+ Add photos'}
          </button>
          <input ref={file} type="file" multiple accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => pickPhotos([...(e.target.files ?? [])])} />
        </div>
        <span style={{ display: 'flex', gap: 6 }}>
          <input className="input" aria-label="Photo link" placeholder="or paste a photo link" value={photoLink} onChange={(e) => setPhotoLink(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addLink())} style={{ height: 34, fontSize: 13, flex: 1, minWidth: 0 }} />
          <button type="button" className="btn sm" onClick={addLink} disabled={!photoLink.trim()}>
            Add
          </button>
        </span>
        {photoColors.length > 0 && <small className="muted">Give each colour its own photo, and the bot sends that photo when a customer asks to see the colour.</small>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>
          Video <small className="muted">(optional; MP4, MOV or WebM up to {MAX_VIDEO_MB} MB)</small>
        </span>
        {videoUrl ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
            <video src={videoUrl} controls preload="metadata" style={{ width: '100%', maxWidth: 360, maxHeight: 320, borderRadius: 12, background: '#000' }} />
            <button type="button" className="btn link" onClick={() => setVideoUrl('')} disabled={busy}>
              Remove video
            </button>
          </div>
        ) : (
          <>
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <button type="button" className="btn sm" onClick={() => videoFile.current?.click()} disabled={busy}>
                {videoUploading ? 'Uploading video…' : '+ Add a video'}
              </button>
              <input ref={videoFile} type="file" accept="video/mp4,video/quicktime,video/webm" hidden onChange={(e) => pickVideo(e.target.files?.[0])} />
            </div>
            <span style={{ display: 'flex', gap: 6 }}>
              <input className="input" aria-label="Video link" placeholder="or paste a video link" value={videoLink} onChange={(e) => setVideoLink(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addVideoLink())} style={{ height: 34, fontSize: 13, flex: 1, minWidth: 0 }} />
              <button type="button" className="btn sm" onClick={addVideoLink} disabled={!videoLink.trim()}>
                Add
              </button>
            </span>
          </>
        )}
      </div>
      <div className="row">
        <label className="field" style={{ flex: '2 1 160px' }}>
          Product title
          <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
        </label>
        <label className="field">
          Code
          <input value={code} onChange={(e) => setCode(e.target.value)} required maxLength={60} placeholder="DS-204" />
        </label>
      </div>
      <label className="field">
        Description
        <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} placeholder="Fabric, fit, care. The bot uses this to answer questions." />
      </label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>Stock by colour and size</span>
        <div style={{ overflowX: 'auto' }}>
          <table className="grid">
            <thead>
              <tr>
                <th>{grid.colors.length ? 'Colour' : ''}</th>
                {sizes.map((s) => (
                  <th key={s}>
                    {s || 'Stock'}
                    {s && (
                      <button type="button" className="btn link" aria-label={`Remove size ${s}`} onClick={() => setGrid((g) => ({ ...g, sizes: g.sizes.filter((x) => x !== s) }))} style={{ marginLeft: 4 }}>
                        ×
                      </button>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {colors.map((c) => (
                <tr key={c}>
                  <td>
                    {c}
                    {c && (
                      <button type="button" className="btn link" aria-label={`Remove ${c}`} onClick={() => setGrid((g) => ({ ...g, colors: g.colors.filter((x) => x !== c) }))} style={{ marginLeft: 4 }}>
                        ×
                      </button>
                    )}
                  </td>
                  {sizes.map((s) => (
                    <td key={s}>
                      <input className="cell" aria-label={[c, s].filter(Boolean).join(' ') || 'Stock'} inputMode="numeric" value={grid.stock[cell(c, s)] ?? '0'} onChange={(e) => setStock(c, s, e.target.value)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <span style={{ display: 'flex', gap: 6 }}>
            <input className="cell wide" aria-label="New colour" placeholder="Colour" value={newColor} onChange={(e) => setNewColor(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addColor())} />
            <button type="button" className="btn sm" onClick={addColor}>
              + Add colour
            </button>
          </span>
          <span style={{ display: 'flex', gap: 6 }}>
            <input className="cell wide" aria-label="New size" placeholder="Size" value={newSize} onChange={(e) => setNewSize(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addSize())} />
            <button type="button" className="btn sm" onClick={addSize}>
              + Add size
            </button>
          </span>
        </div>
      </div>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div className="field">
          Total quantity
          <strong style={{ fontSize: 18 }}>{num(total)} pcs</strong>
        </div>
        <label className="field">
          Price (৳)
          <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" required placeholder="1250" />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> Draft: the bot doesn&apos;t offer it yet
      </label>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="save-bar">
        {product && (
          <button type="button" className="btn link" style={{ marginRight: 'auto', color: 'var(--red)' }} onClick={archive} disabled={busy}>
            Remove product
          </button>
        )}
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={busy}>
          {busy && !uploading ? 'Saving…' : 'Save product'}
        </button>
      </div>
      <p className="sub" style={{ margin: 0 }}>
        The bot quotes this price and stock to customers the moment you save.
      </p>
    </form>
  );
}
