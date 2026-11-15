'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useShop } from '@/components/Shell';
import { AddToProduct } from '@/components/AddToProduct';
import { Icon } from '@/components/icons';
import { Empty, Loading, Notice, Pill, TopBar } from '@/components/ui';
import { ApiError, qs, useApi, useLoad, useUpload } from '@/lib/api';
import { shrinkImage } from '@/lib/image';

interface Model {
  id: string;
  name: string;
  imageUrl: string;
  own?: boolean;
}
interface TryOnImage {
  id: string;
  characterId: string | null;
  modelImageUrl: string;
  garmentImageUrl: string;
  status: 'pending' | 'succeeded' | 'failed';
  resultImageUrl: string | null;
  error: string | null;
  createdAt: string;
}

type Shot = 'product' | 'model' | 'lifestyle';
type Aspect = '1:1' | '4:5' | '9:16' | '16:9';
type Surface = '' | 'podium' | 'marble' | 'wood' | 'glass' | 'sand' | 'water' | 'fabric' | 'floating';
type Background = '' | 'white' | 'dark' | 'gradient' | 'sunset' | 'beach' | 'garden' | 'kitchen' | 'cafe' | 'street' | 'festive';
type Lighting = '' | 'studio' | 'daylight' | 'golden' | 'evening' | 'rim' | 'neon';
type Camera = '' | 'front' | 'shallow' | 'three-quarter' | 'top' | 'low' | 'macro' | 'full';
type Effect = 'splash' | 'condensation' | 'drops' | 'ice' | 'smoke' | 'fruit' | 'petals' | 'sparkles';

const SHOTS: { value: Shot; label: string; hint: string; icon: keyof typeof Icon; tone: string; recommended?: boolean }[] = [
  { value: 'product', label: 'Product only', hint: 'A studio ad of the product, no person', icon: 'catalog', tone: 'blue' },
  { value: 'model', label: 'With a model', hint: 'A model wears, holds or uses it', icon: 'models', tone: 'violet', recommended: true },
  { value: 'lifestyle', label: 'Lifestyle scene', hint: 'The product in a real moment, by a pool or at a table', icon: 'images', tone: 'amber' },
];

interface Look {
  id: string;
  label: string;
  swatch: string;
  surface: Surface;
  background: Background;
  lighting: Lighting;
  camera: Camera;
  effects: Effect[];
}
const LOOKS: Look[] = [
  {
    id: 'splash',
    label: 'Premium splash',
    swatch: 'linear-gradient(160deg,#3b2410,#c27a2c 60%,#f3c06b)',
    surface: 'podium',
    background: 'sunset',
    lighting: 'golden',
    camera: 'shallow',
    effects: ['splash', 'condensation'],
  },
  {
    id: 'white',
    label: 'Clean white',
    swatch: 'linear-gradient(160deg,#ffffff,#d0d5dd)',
    surface: 'floating',
    background: 'white',
    lighting: 'studio',
    camera: 'front',
    effects: [],
  },
  {
    id: 'outdoor',
    label: 'Golden outdoor',
    swatch: 'linear-gradient(160deg,#f6d38a,#e08a3c 55%,#6b8f4e)',
    surface: 'wood',
    background: 'garden',
    lighting: 'golden',
    camera: 'three-quarter',
    effects: ['petals'],
  },
  {
    id: 'eid',
    label: 'Festive Eid',
    swatch: 'linear-gradient(160deg,#0f3d3a,#1f6f5c 55%,#d4a640)',
    surface: 'marble',
    background: 'festive',
    lighting: 'evening',
    camera: 'front',
    effects: ['sparkles'],
  },
  {
    id: 'luxury',
    label: 'Dark luxury',
    swatch: 'linear-gradient(160deg,#0b0b12,#2a2340 60%,#8a7650)',
    surface: 'glass',
    background: 'dark',
    lighting: 'rim',
    camera: 'low',
    effects: ['smoke'],
  },
  {
    id: 'fresh',
    label: 'Fresh and natural',
    swatch: 'linear-gradient(160deg,#e9f7ef,#9ed8b6 55%,#4aa37a)',
    surface: 'sand',
    background: 'beach',
    lighting: 'daylight',
    camera: 'top',
    effects: ['drops', 'fruit'],
  },
];

const SURFACES: { value: Surface; label: string }[] = [
  { value: '', label: 'Let the AI choose' },
  { value: 'podium', label: 'Dark stone podium' },
  { value: 'marble', label: 'Marble' },
  { value: 'wood', label: 'Wooden table' },
  { value: 'glass', label: 'Black glass' },
  { value: 'sand', label: 'Sand' },
  { value: 'water', label: 'Water surface' },
  { value: 'fabric', label: 'Fabric' },
  { value: 'floating', label: 'None, floating' },
];
const BACKGROUNDS: { value: Background; label: string }[] = [
  { value: '', label: 'Let the AI choose' },
  { value: 'white', label: 'Plain white studio' },
  { value: 'dark', label: 'Plain dark colour' },
  { value: 'gradient', label: 'Soft gradient' },
  { value: 'sunset', label: 'Sunset over mountains and water' },
  { value: 'beach', label: 'Beach' },
  { value: 'garden', label: 'Garden and greenery' },
  { value: 'kitchen', label: 'Kitchen' },
  { value: 'cafe', label: 'Café' },
  { value: 'street', label: 'City street' },
  { value: 'festive', label: 'Eid lights and decor' },
];
const LIGHTINGS: { value: Lighting; label: string }[] = [
  { value: '', label: 'Let the AI choose' },
  { value: 'studio', label: 'Soft studio light' },
  { value: 'daylight', label: 'Bright daylight' },
  { value: 'golden', label: 'Golden-hour backlight' },
  { value: 'evening', label: 'Warm evening light' },
  { value: 'rim', label: 'Dramatic rim light' },
  { value: 'neon', label: 'Neon' },
];
const CAMERAS: { value: Camera; label: string }[] = [
  { value: '', label: 'Let the AI choose' },
  { value: 'front', label: 'Front, eye level' },
  { value: 'shallow', label: 'Eye level, blurred background' },
  { value: 'three-quarter', label: 'Three-quarter angle' },
  { value: 'top', label: 'Top-down' },
  { value: 'low', label: 'Low angle' },
  { value: 'macro', label: 'Close-up' },
  { value: 'full', label: 'Full body (with a person)' },
];
const EFFECTS: { value: Effect; label: string }[] = [
  { value: 'splash', label: 'Liquid splash' },
  { value: 'condensation', label: 'Condensation drops' },
  { value: 'drops', label: 'Water drops' },
  { value: 'ice', label: 'Ice' },
  { value: 'smoke', label: 'Smoke and mist' },
  { value: 'fruit', label: 'Fruit slices' },
  { value: 'petals', label: 'Petals' },
  { value: 'sparkles', label: 'Sparkles' },
];
const SIZES: { value: Aspect; label: string; use: string; w: number; h: number }[] = [
  { value: '1:1', label: 'Square 1:1', use: 'Facebook post', w: 22, h: 22 },
  { value: '4:5', label: 'Portrait 4:5', use: 'Feed post', w: 20, h: 25 },
  { value: '9:16', label: 'Story 9:16', use: 'Story, reel', w: 14, h: 25 },
  { value: '16:9', label: 'Wide 16:9', use: 'Cover, banner', w: 28, h: 16 },
];

const MAX_NOTE = 500;
/** Same limit as the API: product photos are at most 5 MB after shrinking. */
const MAX_PHOTO_MB = 5;

/** Every model in one list. Tapping the chosen one again unselects it. */
function ModelGrid({ models, current, onPick }: { models: Model[]; current?: Model; onPick: (m: Model | undefined) => void }) {
  return (
    <>
      <div className="card-head">
        <strong style={{ fontSize: 13 }}>Choose a model</strong>
        <Link href="/model-images?add=model" className="btn sm light">
          + Add your own model
        </Link>
      </div>
      {models.length === 0 && <Empty>No models here yet.</Empty>}
      <div className="pick">
        {models.map((m) => (
          <button
            key={m.id}
            type="button"
            className={current?.id === m.id ? 'on' : ''}
            aria-pressed={current?.id === m.id}
            onClick={() => onPick(current?.id === m.id ? undefined : m)}
          >
            <img src={m.imageUrl} alt="" loading="lazy" />
            <span>
              {m.name}
              {m.own && ' · Yours'}
            </span>
          </button>
        ))}
      </div>
      <small className="muted">No model picked? The AI creates one, from your instructions if you write any.</small>
    </>
  );
}

function Select<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <label className="field">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Generate image: upload any product, choose the kind of photo and a look,
 * and the AI makes advertising photos of it.
 */
export default function GenerateImagePage() {
  const { ws, manager, reloadHome } = useShop();
  const api = useApi();
  const upload = useUpload();
  const router = useRouter();
  const setup = useLoad<{ models: Model[]; enabled: boolean; creditsPerImage: number; styleOptions?: boolean }>(manager ? `${ws}/try-on/models` : null);
  const [garment, setGarment] = useState<string>();
  const [productName, setProductName] = useState('');
  const [shot, setShot] = useState<Shot>('product');
  const [model, setModel] = useState<Model>();
  const [look, setLook] = useState<string>('');
  const [surface, setSurface] = useState<Surface>('');
  const [background, setBackground] = useState<Background>('');
  const [lighting, setLighting] = useState<Lighting>('');
  const [camera, setCamera] = useState<Camera>('');
  const [effects, setEffects] = useState<Effect[]>([]);
  const [aspect, setAspect] = useState<Aspect>('1:1');
  const [note, setNote] = useState('');
  const [count, setCount] = useState(1);
  const [prompt, setPrompt] = useState<string>();
  const [showPrompt, setShowPrompt] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const [adding, setAdding] = useState<TryOnImage>();
  // Images started on this page, newest first.
  const [made, setMade] = useState<TryOnImage[]>([]);
  const file = useRef<HTMLInputElement>(null);

  // Opened as /generate-image?model=<id> from the models page.
  const models0 = setup.data?.models;
  useEffect(() => {
    if (!models0) return;
    const want = new URLSearchParams(window.location.search).get('model');
    if (!want) return;
    const m = models0.find((x) => x.id === want);
    if (m) {
      setShot('model');
      setModel(m);
    }
    window.history.replaceState(null, '', window.location.pathname);
  }, [models0]);

  // FASHN (styleOptions off) only dresses a model photo: none of the scene choices apply.
  const styleOptions = setup.data?.styleOptions !== false;
  const kind: Shot = styleOptions ? shot : 'model';
  const chosen = kind === 'product' ? undefined : model;

  const body = {
    ...(chosen && { characterId: chosen.id }),
    category: 'auto',
    ...(styleOptions && {
      shot: kind,
      aspect,
      ...(surface && kind !== 'model' && { surface }),
      ...(background && { background }),
      ...(lighting && { lighting }),
      ...(camera && { camera }),
      ...(effects.length && { effects }),
      ...(productName.trim() && { productName: productName.trim() }),
      ...(note.trim() && { note: note.trim() }),
    }),
  };
  const bodyKey = JSON.stringify(body);

  // The words the AI will get, refreshed shortly after each change while the box is open.
  useEffect(() => {
    if (!showPrompt || !styleOptions) return;
    const t = setTimeout(async () => {
      try {
        const r = await api<{ prompt: string }>(`${ws}/try-on/prompt`, { method: 'POST', body: JSON.parse(bodyKey) });
        setPrompt(r.prompt);
      } catch {
        setPrompt(undefined);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [api, ws, bodyKey, showPrompt, styleOptions]);

  // While an image is being made, check every few seconds.
  const pending = made.some((i) => i.status === 'pending');
  const refresh = useCallback(async () => {
    try {
      const r = await api<{ images: TryOnImage[] }>(`${ws}/try-on`);
      setMade((cur) => cur.map((i) => r.images.find((x) => x.id === i.id) ?? i));
    } catch {
      // Try again on the next tick.
    }
  }, [api, ws]);
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [pending, refresh]);

  async function pickGarment(f: File | undefined) {
    if (!f) return;
    setUploading(true);
    setError(undefined);
    try {
      const small = await shrinkImage(f);
      if (small.size > MAX_PHOTO_MB * 1024 * 1024) throw new Error(`The photo is larger than ${MAX_PHOTO_MB} MB. Use a smaller one.`);
      const r = await upload<{ url: string }>(`${ws}/uploads/images`, small, 60_000);
      setGarment(r.url);
    } catch (e) {
      setError((e as ApiError).status === 503 ? 'Photo uploads are not switched on yet.' : (e as Error).message);
    } finally {
      setUploading(false);
      if (file.current) file.current.value = '';
    }
  }

  function pickLook(l: Look) {
    setLook(l.id);
    setSurface(l.surface);
    setBackground(l.background);
    setLighting(l.lighting);
    setCamera(l.camera);
    setEffects(l.effects);
  }
  // Changing one field by hand makes it a custom look.
  const custom =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setLook('');
    };

  if (!manager) {
    return (
      <>
        <TopBar title="Generate image" />
        <div className="content">
          <Notice tone="info">Only the shop owner and admins can generate images.</Notice>
        </div>
      </>
    );
  }

  const credits = setup.data?.creditsPerImage ?? 0;
  // FASHN needs a model photo; the image models make everything else themselves.
  const ready = !!garment && (styleOptions || !!chosen);
  const size = SIZES.find((s) => s.value === aspect)!;

  async function generate() {
    if (!ready || !garment) return;
    setStarting(true);
    setError(undefined);
    setDone(undefined);
    try {
      for (let i = 0; i < count; i++) {
        const r = await api<{ image: TryOnImage }>(`${ws}/try-on`, { method: 'POST', body: { ...body, garmentImageUrl: garment } });
        setMade((cur) => [r.image, ...cur]);
      }
      reloadHome();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  return (
    <>
      <TopBar title="Generate image" back={{ href: '/media', label: 'Media library' }} />
      <div className="content tryon-page">
        <p className="sub" style={{ margin: 0, fontSize: 14 }}>
          Upload any product, pick a look, and the AI makes an advertising photo of it. Every image is also saved in your Media library.
        </p>
        {setup.data && !setup.data.enabled && <Notice tone="warn">Making images is not switched on for Agently yet. It will be soon.</Notice>}
        {done && <Notice tone="ok">{done}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
        {setup.error && <Notice tone="error">{setup.error}</Notice>}

        <div className="tryon">
          <div className="tryon-col">
            <section className="card pad" aria-label="Upload your product">
              <h2>1. Upload your product</h2>
              <div className="gen-upload">
                <button type="button" className="garment" onClick={() => file.current?.click()} disabled={uploading}>
                  {garment ? (
                    <img src={garment} alt="Your product" />
                  ) : uploading ? (
                    'Uploading…'
                  ) : (
                    <span className="garment-empty">
                      <span className="opt-icon blue" aria-hidden="true">
                        <Icon.upload />
                      </span>
                      <strong>Choose a photo</strong>
                      <small>JPG, PNG or WebP</small>
                    </span>
                  )}
                </button>
                <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => pickGarment(e.target.files?.[0])} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: '1 1 220px', minWidth: 0 }}>
                  {styleOptions && (
                    <label className="field">
                      What is it? (optional)
                      <input
                        value={productName}
                        maxLength={80}
                        onChange={(e) => setProductName(e.target.value)}
                        placeholder="e.g. iced coffee bottle, leather handbag"
                      />
                    </label>
                  )}
                  <small className="muted">
                    Any product works: clothes, shoes, bags, drinks, food, cosmetics, gadgets. The product is always kept as it is, with its own label and
                    colours. Best results: the whole product in good light, on a plain background.
                  </small>
                </div>
              </div>
            </section>

            <section className="card pad" aria-label="Photo type">
              <h2>2. Photo type</h2>
              {styleOptions && (
                <div className="gen-types" role="radiogroup" aria-label="Photo type">
                  {SHOTS.map((s) => {
                    const ShotIcon = Icon[s.icon];
                    return (
                      <button
                        key={s.value}
                        type="button"
                        role="radio"
                        className={`opt${kind === s.value ? ' on' : ''}`}
                        aria-checked={kind === s.value}
                        onClick={() => setShot(s.value)}
                      >
                        <span className="opt-radio" aria-hidden="true" />
                        <span className={`opt-icon ${s.tone}`} aria-hidden="true">
                          <ShotIcon />
                        </span>
                        <span className="opt-text">
                          <strong>
                            {s.label}
                            {s.recommended && <span className="badge-rec">Recommended</span>}
                          </strong>
                          <span>{s.hint}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              {kind !== 'product' && setup.data && <ModelGrid models={setup.data.models} current={model} onPick={setModel} />}
              {kind !== 'product' && !setup.data && <Loading />}
            </section>

            {styleOptions && (
              <section className="card pad" aria-label="Pick a look">
                <div className="card-head">
                  <h2>3. Pick a look</h2>
                  <small className="muted">One tap fills the scene below. Change anything after.</small>
                </div>
                <div className="gen-looks">
                  {LOOKS.map((l) => (
                    <button key={l.id} type="button" className={look === l.id ? 'on' : ''} aria-pressed={look === l.id} onClick={() => pickLook(l)}>
                      <span className="sw" style={{ background: l.swatch }} />
                      <span className="lb">{l.label}</span>
                    </button>
                  ))}
                </div>
                <div className="gen-grid">
                  {kind !== 'model' && <Select label="Surface" value={surface} options={SURFACES} onChange={custom(setSurface)} />}
                  <Select label="Background" value={background} options={BACKGROUNDS} onChange={custom(setBackground)} />
                  <Select label="Lighting" value={lighting} options={LIGHTINGS} onChange={custom(setLighting)} />
                  <Select label="Camera" value={camera} options={CAMERAS} onChange={custom(setCamera)} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <strong style={{ fontSize: 13 }}>Effects (pick any)</strong>
                  <div className="chips" role="group" aria-label="Effects">
                    {EFFECTS.map((e) => {
                      const on = effects.includes(e.value);
                      return (
                        <button
                          key={e.value}
                          type="button"
                          className={`chip${on ? ' on' : ''}`}
                          aria-pressed={on}
                          onClick={() => custom(setEffects)(on ? effects.filter((x) => x !== e.value) : [...effects, e.value])}
                        >
                          {e.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </section>
            )}

            <section className="card pad" aria-label="Size and details">
              <h2>{styleOptions ? '4. Size and details' : '3. Details'}</h2>
              {styleOptions && (
                <div className="gen-sizes">
                  {SIZES.map((s) => (
                    <button
                      key={s.value}
                      type="button"
                      className={aspect === s.value ? 'on' : ''}
                      aria-pressed={aspect === s.value}
                      onClick={() => setAspect(s.value)}
                    >
                      <span className="box" style={{ width: s.w, height: s.h }} />
                      <strong>{s.label}</strong>
                      <span>{s.use}</span>
                    </button>
                  ))}
                </div>
              )}
              {styleOptions && (
                <label className="field">
                  Your own instructions (optional)
                  <textarea
                    rows={3}
                    maxLength={MAX_NOTE}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder={
                      kind === 'product'
                        ? 'e.g. a splash of iced coffee wraps around the bottle, palm leaves on the left'
                        : 'e.g. a woman relaxing by a pool, taking a sip from the can, sunny day'
                    }
                  />
                </label>
              )}
              {styleOptions && <small className="muted">Write in English for best results. Keep it tasteful: the AI refuses suggestive photos.</small>}

              {styleOptions && (
                <div className="gen-prompt">
                  <button type="button" aria-expanded={showPrompt} onClick={() => setShowPrompt(!showPrompt)}>
                    See the prompt we send to the AI
                    <span aria-hidden="true">{showPrompt ? '▲' : '▼'}</span>
                  </button>
                  {showPrompt && <p>{prompt ?? 'Loading…'}</p>}
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  Images
                  <select value={count} onChange={(e) => setCount(Number(e.target.value))} style={{ width: 72 }}>
                    {[1, 2, 3, 4].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="btn primary"
                  style={{ flex: '1 1 220px' }}
                  disabled={!ready || starting || uploading || !setup.data?.enabled}
                  onClick={generate}
                >
                  {starting ? 'Starting…' : `Generate ${count} image${count > 1 ? 's' : ''}${credits ? ` · ${credits * count} credits` : ''}`}
                </button>
              </div>
              {!ready && <small className="muted">{!garment ? 'Upload the product photo.' : 'Choose a model above.'}</small>}
            </section>
          </div>

          <section aria-label="Made here" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <h2 style={{ fontSize: 16 }}>Your new images</h2>
            {setup.loading && !setup.data && <Loading />}
            {made.length === 0 && (
              <div className="gen-preview" style={{ aspectRatio: `${size.w} / ${size.h}` }}>
                <span>{size.label}</span>
                <small>
                  Images show here in about half a minute. Older ones are in the <Link href="/media">Media library</Link>.
                </small>
              </div>
            )}
            <div className="results">
              {made.map((img) => (
                <div key={img.id} className="result">
                  <div className="ph">
                    {img.status === 'succeeded' && img.resultImageUrl ? (
                      <a href={img.resultImageUrl} target="_blank" rel="noreferrer">
                        <img src={img.resultImageUrl} alt="Your product photo" style={{ objectFit: 'contain' }} />
                      </a>
                    ) : img.status === 'pending' ? (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                        <div className="spinner" aria-hidden="true" />
                        Making your image…
                      </div>
                    ) : (
                      <div style={{ padding: 16 }}>{img.error ?? 'This image could not be made.'}</div>
                    )}
                  </div>
                  <div className="info">
                    {img.status === 'succeeded' && img.resultImageUrl && (
                      <>
                        <button type="button" className="btn sm primary" onClick={() => setAdding(img)}>
                          Add to a product
                        </button>
                        <button type="button" className="btn sm" onClick={() => router.push(`/catalog${qs({ newPhoto: img.resultImageUrl })}`)}>
                          New product
                        </button>
                      </>
                    )}
                    {img.status === 'failed' && <Pill tone="red">Failed</Pill>}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>

      {adding?.resultImageUrl && (
        <AddToProduct
          url={adding.resultImageUrl}
          onClose={() => setAdding(undefined)}
          onDone={(p) => {
            setAdding(undefined);
            setDone(`Added to ${p.title}. Open the Product Catalog to make it the main photo or tag a colour.`);
          }}
        />
      )}
    </>
  );
}
