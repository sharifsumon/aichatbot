'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useShop } from '@/components/Shell';
import { AddToProduct } from '@/components/AddToProduct';
import { Icon } from '@/components/icons';
import { Empty, Loading, Notice, Pill, TopBar } from '@/components/ui';
import { ApiError, qs, useApi, useLoad, useUpload } from '@/lib/api';
import { date } from '@/lib/format';
import { shrinkImage } from '@/lib/image';
import type { MediaAllowance } from '@/lib/types';

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

const SHOTS: { value: Shot; label: string; hint: string }[] = [
  { value: 'product', label: 'Product only', hint: 'A studio ad of the product, no person' },
  { value: 'model', label: 'With a model', hint: 'A model wears, holds or uses it' },
  { value: 'lifestyle', label: 'Lifestyle scene', hint: 'The product in a real moment, by a pool or at a table' },
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
const EFFECTS: { value: Effect; label: string; swatch: string }[] = [
  { value: 'splash', label: 'Liquid splash', swatch: 'linear-gradient(160deg,#7c3a10,#e08a3c 55%,#f6d38a)' },
  { value: 'condensation', label: 'Condensation drops', swatch: 'linear-gradient(160deg,#dbeafe,#93c5fd 60%,#eff6ff)' },
  {
    value: 'drops',
    label: 'Water drops',
    swatch:
      'radial-gradient(circle at 30% 35%,#fff 0 6%,transparent 7%),radial-gradient(circle at 70% 60%,#fff 0 5%,transparent 6%),linear-gradient(160deg,#0ea5e9,#38bdf8)',
  },
  { value: 'ice', label: 'Ice', swatch: 'linear-gradient(160deg,#e0f2fe,#bae6fd 50%,#f0f9ff)' },
  { value: 'smoke', label: 'Smoke and mist', swatch: 'linear-gradient(160deg,#1f2937,#6b7280 55%,#d1d5db)' },
  { value: 'fruit', label: 'Fruit slices', swatch: 'linear-gradient(160deg,#fb923c,#facc15 50%,#84cc16)' },
  { value: 'petals', label: 'Petals', swatch: 'linear-gradient(160deg,#fce7f3,#f9a8d4 55%,#fda4af)' },
  {
    value: 'sparkles',
    label: 'Sparkles',
    swatch:
      'radial-gradient(circle at 25% 30%,#fde68a 0 4%,transparent 5%),radial-gradient(circle at 70% 65%,#fde68a 0 3%,transparent 4%),linear-gradient(160deg,#1e1b4b,#4338ca)',
  },
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

function labelOf<T extends string>(options: { value: T; label: string }[], v: T) {
  return options.find((o) => o.value === v)?.label ?? '';
}

/** A section header: a pastel icon tile, the title, and a green badge or a grey note. */
function SectionHead({ icon, tone, title, badge, note }: { icon: keyof typeof Icon; tone: string; title: string; badge?: string; note?: string }) {
  const I = Icon[icon];
  return (
    <div className="gen-head">
      <span className={`opt-icon lg ${tone}`} aria-hidden="true">
        <I />
      </span>
      <h2>{title}</h2>
      {badge && <span className="badge-ok">{badge}</span>}
      {note && <span className="muted">{note}</span>}
    </div>
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
  const allowance = useLoad<MediaAllowance>(manager ? `${ws}/media-allowance` : null);
  // Images the plan has left this month (null when the plan has no cap), and how many more top-up credits pay for.
  const planImagesLeft = allowance.data && allowance.data.images.limit !== null ? Math.max(0, allowance.data.images.limit - allowance.data.images.used) : null;
  const perImage = setup.data?.creditsPerImage ?? 0;
  const topUpImages = allowance.data && perImage > 0 ? Math.floor(allowance.data.topUpCredits / perImage) : 0;
  const imagesLeft = planImagesLeft === null ? null : planImagesLeft + topUpImages;
  const counts = [1, 2, 3, 4].filter((n) => imagesLeft === null || n <= imagesLeft);
  useEffect(() => {
    // Keep the number of images within what is left.
    if (imagesLeft !== null && imagesLeft > 0 && count > imagesLeft) setCount(imagesLeft);
  }, [imagesLeft, count]);
  const [prompt, setPrompt] = useState<string>();
  const [showPrompt, setShowPrompt] = useState(true);
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

  // Started on this page: shown in the preview.
  const [mine, setMine] = useState<string[]>([]);
  const latest = made.filter((i) => mine.includes(i.id));

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
  const ready = !!garment && (styleOptions || !!chosen) && imagesLeft !== 0;
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
        setMine((cur) => [r.image.id, ...cur]);
      }
      reloadHome();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
      allowance.reload();
    }
  }

  const summary: [string, string][] = styleOptions
    ? [
        ['Photo', SHOTS.find((x) => x.value === kind)!.label + (chosen ? ` · ${chosen.name}` : '')],
        ['Style', LOOKS.find((l) => l.id === look)?.label ?? 'Custom'],
        ...(kind !== 'model' ? [['Surface', labelOf(SURFACES, surface)] as [string, string]] : []),
        ['Background', labelOf(BACKGROUNDS, background)],
        ['Effects', effects.length ? effects.map((e) => labelOf(EFFECTS, e)).join(', ') : 'None'],
        ['Format', `${size.label} · ${count} image${count > 1 ? 's' : ''}`],
      ]
    : [['Model', chosen?.name ?? 'Not chosen yet']];

  return (
    <>
      <TopBar title="Generate image" back={{ href: '/media', label: 'Media library' }} />
      <div className="content tryon-page gen-page">
        <div className="gen-hero">
          <div>
            <h1>Generate a product image</h1>
            <p>Upload your product and pick a look. We write the AI prompt for you.</p>
          </div>
          {credits > 0 && (
            <span className="gen-pill">
              <Icon.sparkle /> <strong>{credits}</strong> credits per image
            </span>
          )}
        </div>
        {setup.data && !setup.data.enabled && <Notice tone="warn">Making images is not switched on for Agently yet. It will be soon.</Notice>}
        {allowance.data && allowance.data.images.limit !== null && (
          <Notice tone={imagesLeft ? 'info' : 'warn'}>
            {planImagesLeft
              ? `Your plan includes ${allowance.data.images.limit} AI images a month. ${allowance.data.images.used} used, ${planImagesLeft} left until ${date(allowance.data.periodEnd)}.${topUpImages ? ` Top-up credits pay for ${topUpImages} more.` : ''}`
              : topUpImages
                ? `This month's ${allowance.data.images.limit} plan images are used up. More images use top-up credits (${perImage} each): ${allowance.data.topUpCredits} left, enough for ${topUpImages}.`
                : `This month's ${allowance.data.images.limit} AI images are used up. Top up credits to make more, or upgrade, in Settings → Billing. Your plan's images come back on ${date(allowance.data.periodEnd)}.`}
          </Notice>
        )}
        {done && <Notice tone="ok">{done}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
        {setup.error && <Notice tone="error">{setup.error}</Notice>}

        <div className="gen-layout">
          <div className="gen-main">
            <section className={`card pad gen-sec${!garment ? ' active' : ''}`} aria-label="Your product">
              <SectionHead icon="catalog" tone="blue" title="Your product" badge="Required" />
              <div className="gen-upload">
                <button type="button" className="garment" onClick={() => file.current?.click()} disabled={uploading}>
                  {garment ? (
                    <img src={garment} alt="Your product" />
                  ) : uploading ? (
                    'Uploading…'
                  ) : (
                    <span className="garment-empty">
                      <span className="gen-label">Product photo</span>
                      <small>No photo selected yet.</small>
                      <span className="btn">
                        <Icon.upload /> Choose photo
                      </span>
                    </span>
                  )}
                </button>
                <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => pickGarment(e.target.files?.[0])} />
                <div className="gen-upload-side">
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
                  {garment && (
                    <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => file.current?.click()} disabled={uploading}>
                      <Icon.upload /> Change photo
                    </button>
                  )}
                </div>
              </div>
            </section>

            {styleOptions && (
              <section className="card pad gen-sec" aria-label="Choose a style">
                <SectionHead icon="sparkle" tone="violet" title="Choose a style" badge="Fills the scene for you" />
                <div className="gen-looks" role="group" aria-label="Style">
                  {LOOKS.map((l) => (
                    <button key={l.id} type="button" className={look === l.id ? 'on' : ''} aria-pressed={look === l.id} onClick={() => pickLook(l)}>
                      <span className="sw" style={{ background: l.swatch }} />
                      <span className="lb">{l.label}</span>
                    </button>
                  ))}
                  <button type="button" className={`custom${look === '' ? ' on' : ''}`} aria-pressed={look === ''} onClick={() => setLook('')}>
                    <span className="sw" aria-hidden="true">
                      +
                    </span>
                    <span className="lb">Custom</span>
                  </button>
                </div>
              </section>
            )}

            {styleOptions && (
              <section className="card pad gen-sec" aria-label="Scene">
                <SectionHead icon="images" tone="amber" title="Scene" />
                <div className="gen-grid">
                  {kind !== 'model' && <Select label="Surface" value={surface} options={SURFACES} onChange={custom(setSurface)} />}
                  <Select label="Background" value={background} options={BACKGROUNDS} onChange={custom(setBackground)} />
                </div>
                <div className="gen-row">
                  <span className="gen-label">
                    Effects <span className="muted">(pick any)</span>
                  </span>
                  <div className="gen-looks" role="group" aria-label="Effects">
                    {EFFECTS.map((e) => {
                      const on = effects.includes(e.value);
                      return (
                        <button
                          key={e.value}
                          type="button"
                          className={on ? 'on' : ''}
                          aria-pressed={on}
                          onClick={() => custom(setEffects)(on ? effects.filter((x) => x !== e.value) : [...effects, e.value])}
                        >
                          <span className="sw" style={{ background: e.swatch }} />
                          <span className="lb">{e.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="gen-grid">
                  <Select label="Lighting" value={lighting} options={LIGHTINGS} onChange={custom(setLighting)} />
                  <Select label="Camera angle" value={camera} options={CAMERAS} onChange={custom(setCamera)} />
                </div>
              </section>
            )}

            <section className="card pad gen-sec" aria-label="Use a model">
              <SectionHead icon="models" tone="green" title="Use a model" note={styleOptions ? 'Optional' : undefined} />
              {styleOptions && (
                <div className="gen-types" role="radiogroup" aria-label="Photo type">
                  {SHOTS.map((s) => (
                    <button
                      key={s.value}
                      type="button"
                      role="radio"
                      className={`opt${kind === s.value ? ' on' : ''}`}
                      aria-checked={kind === s.value}
                      onClick={() => setShot(s.value)}
                    >
                      <span className="opt-radio" aria-hidden="true" />
                      <span className="opt-text">
                        <strong>{s.label}</strong>
                        <span>{s.hint}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {kind !== 'product' && setup.data && <ModelGrid models={setup.data.models} current={model} onPick={setModel} />}
              {kind !== 'product' && !setup.data && <Loading />}
            </section>

            <section className="card pad gen-sec" aria-label="Format">
              <SectionHead icon="post" tone="teal" title={styleOptions ? 'Format' : 'Details'} />
              {styleOptions && (
                <div className="chips" role="group" aria-label="Size">
                  {SIZES.map((s) => (
                    <button
                      key={s.value}
                      type="button"
                      className={`chip${aspect === s.value ? ' on' : ''}`}
                      aria-pressed={aspect === s.value}
                      onClick={() => setAspect(s.value)}
                    >
                      <span className="ratio" style={{ width: Math.round(s.w * 0.7), height: Math.round(s.h * 0.7) }} aria-hidden="true" />
                      {s.value} {s.use}
                    </button>
                  ))}
                </div>
              )}
              <div className="gen-stack">
                {styleOptions && (
                  <label className="field">
                    Custom Prompt (optional)
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
                    <small>Write in English for best results. Keep it tasteful: the AI refuses suggestive photos.</small>
                  </label>
                )}
                <label className="field gen-count">
                  Number of images
                  <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
                    {(counts.length ? counts : [1]).map((n) => (
                      <option key={n} value={n}>
                        {n} image{n > 1 ? 's' : ''}
                        {credits ? ` · ${credits * n} credits` : ''}
                      </option>
                    ))}
                  </select>
                  {credits > 0 && <small>Each image uses {credits} credits.</small>}
                </label>
              </div>
            </section>

            <div className="gen-actions">
              <Link href="/media" className="btn">
                ← Back
              </Link>
              <div className="gen-go">
                {!ready && (
                  <small className="muted">{imagesLeft === 0 ? "This month's images are used up. Top up credits to make more." : !garment ? 'Upload the product photo first.' : 'Choose a model above.'}</small>
                )}
                {credits > 0 && <span className="gen-cost">{credits * count} credits</span>}
                <button type="button" className="btn primary lg" disabled={!ready || starting || uploading || !setup.data?.enabled} onClick={generate}>
                  {starting ? 'Starting…' : `Generate ${count > 1 ? `${count} images` : 'image'}`} <span aria-hidden="true">›</span>
                </button>
              </div>
            </div>
          </div>

          <aside className="gen-aside" aria-label="Preview">
            <div className="card pad">
              <h2 style={{ fontSize: 16 }}>Preview</h2>
              {setup.loading && !setup.data && <Loading />}
              {latest.length === 0 ? (
                <div className="gen-preview" style={{ aspectRatio: `${size.w} / ${size.h}` }}>
                  <Icon.images />
                  <span>Your image appears here ({aspect})</span>
                  <small>
                    Ready in about half a minute. Older ones are in the <Link href="/media">Media library</Link>.
                  </small>
                </div>
              ) : (
                <div className="results">
                  {latest.map((img) => (
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
              )}
              <dl className="gen-summary">
                {summary.map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            </div>

            {styleOptions && (
              <div className="card pad gen-prompt">
                <button type="button" aria-expanded={showPrompt} onClick={() => setShowPrompt(!showPrompt)}>
                  <span>Prompt we will send</span>
                  <span aria-hidden="true">{showPrompt ? '▲' : '▼'}</span>
                </button>
                {showPrompt && <p>{prompt ?? 'Loading…'}</p>}
              </div>
            )}

            <p className="gen-tip">
              Tip: describe people as &quot;adult woman&quot; or &quot;adult man&quot;, and avoid brand names. We tidy risky words automatically.
            </p>
          </aside>
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
