'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useShop } from '@/components/Shell';
import { AddToProduct } from '@/components/AddToProduct';
import { Chips, Empty, Loading, Notice, Pill, TopBar } from '@/components/ui';
import { ApiError, qs, useApi, useLoad, useUpload } from '@/lib/api';
import { shrinkImage } from '@/lib/image';

type Gender = 'female' | 'male';
type Category = 'auto' | 'tops' | 'bottoms' | 'one-pieces';
interface Model {
  id: string;
  name: string;
  gender: Gender;
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

const CATEGORIES: { value: Category; label: string }[] = [
  { value: 'auto', label: 'Let the AI decide' },
  { value: 'one-pieces', label: 'Full outfit (dress, saree, kameez set)' },
  { value: 'tops', label: 'Top (shirt, kurti, t-shirt)' },
  { value: 'bottoms', label: 'Bottom (pants, skirt, palazzo)' },
];

type Pose = '' | 'standing' | 'walking' | 'sitting' | 'hand-on-hip' | 'side' | 'back';
type Expression = '' | 'smile' | 'laughing' | 'neutral' | 'confident';
type Camera = '' | 'closeup' | 'half' | 'full' | 'three-quarter' | 'low' | 'high';
type Background = '' | 'white' | 'grey' | 'pastel' | 'street' | 'garden' | 'indoor' | 'beach' | 'festive';

const POSES: { value: Pose; label: string }[] = [
  { value: '', label: 'Same as the model photo' },
  { value: 'standing', label: 'Standing, full length' },
  { value: 'walking', label: 'Walking' },
  { value: 'sitting', label: 'Sitting' },
  { value: 'hand-on-hip', label: 'Hand on hip' },
  { value: 'side', label: 'Turned to the side' },
  { value: 'back', label: 'Showing the back' },
];
const EXPRESSIONS: { value: Expression; label: string }[] = [
  { value: '', label: 'Same as the model photo' },
  { value: 'smile', label: 'Smiling' },
  { value: 'laughing', label: 'Laughing' },
  { value: 'neutral', label: 'Calm' },
  { value: 'confident', label: 'Confident, serious' },
];
const CAMERAS: { value: Camera; label: string }[] = [
  { value: '', label: 'Same as the model photo' },
  { value: 'closeup', label: 'Close-up (chest up)' },
  { value: 'half', label: 'Waist up' },
  { value: 'full', label: 'Full body' },
  { value: 'three-quarter', label: 'Three-quarter angle' },
  { value: 'low', label: 'Low angle' },
  { value: 'high', label: 'High angle' },
];
const BACKGROUNDS: { value: Background; label: string }[] = [
  { value: '', label: 'Same as the model photo' },
  { value: 'white', label: 'Plain white studio' },
  { value: 'grey', label: 'Light grey studio' },
  { value: 'pastel', label: 'Soft pastel colour' },
  { value: 'street', label: 'City street' },
  { value: 'garden', label: 'Garden' },
  { value: 'indoor', label: 'Living room' },
  { value: 'beach', label: 'Beach' },
  { value: 'festive', label: 'Eid / wedding decor' },
];
const MAX_NOTE = 500;

/** Same limit as the API: product photos are at most 5 MB after shrinking. */
const MAX_PHOTO_MB = 5;

/** Popup with every model to choose from. */
function ModelPicker({ models, current, onPick, onClose }: { models: Model[]; current?: Model; onPick: (m: Model) => void; onClose: () => void }) {
  const [gender, setGender] = useState<Gender | 'all'>('all');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const shown = models.filter((m) => gender === 'all' || m.gender === gender);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog wide tryon-page" role="dialog" aria-modal="true" aria-label="Choose a model">
        <div className="card-head">
          <h2>Choose a model</h2>
          <Link href="/model-images?add=model" className="btn sm light">
            + Add your own model
          </Link>
        </div>
        <Chips
          label="Show"
          value={gender}
          onChange={setGender}
          options={[
            { value: 'all', label: 'All' },
            { value: 'female', label: 'Women' },
            { value: 'male', label: 'Men' },
          ]}
        />
        {shown.length === 0 && <Empty>No models here yet.</Empty>}
        <div className="pick">
          {shown.map((m) => (
            <button key={m.id} type="button" className={current?.id === m.id ? 'on' : ''} aria-pressed={current?.id === m.id} onClick={() => onPick(m)}>
              <img src={m.imageUrl} alt="" loading="lazy" />
              <span>
                {m.name}
                {m.own && ' · Yours'}
              </span>
            </button>
          ))}
        </div>
        <div className="buttons">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Generate image: upload a photo of the dress, optionally pick a model, and
 * the AI makes a photo of the model wearing it.
 */
export default function GenerateImagePage() {
  const { ws, manager, reloadHome } = useShop();
  const api = useApi();
  const upload = useUpload();
  const router = useRouter();
  const setup = useLoad<{ models: Model[]; enabled: boolean; creditsPerImage: number; styleOptions?: boolean }>(manager ? `${ws}/try-on/models` : null);
  const [useModel, setUseModel] = useState(false);
  const [picking, setPicking] = useState(false);
  const [model, setModel] = useState<Model>();
  const [garment, setGarment] = useState<string>();
  const [category, setCategory] = useState<Category>('auto');
  const [pose, setPose] = useState<Pose>('');
  const [expression, setExpression] = useState<Expression>('');
  const [camera, setCamera] = useState<Camera>('');
  const [background, setBackground] = useState<Background>('');
  const [note, setNote] = useState('');
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
      setUseModel(true);
      setModel(m);
    }
    window.history.replaceState(null, '', window.location.pathname);
  }, [models0]);

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
  const styleOptions = setup.data?.styleOptions !== false;
  const chosen = useModel ? model : undefined;
  // Image models can create the model from the shop's description; FASHN needs a model photo.
  const ready = !!garment && (!!chosen || (styleOptions && !!note.trim()));

  async function generate() {
    if (!ready || !garment) return;
    setStarting(true);
    setError(undefined);
    setDone(undefined);
    try {
      const r = await api<{ image: TryOnImage }>(`${ws}/try-on`, {
        method: 'POST',
        body: {
          ...(chosen && { characterId: chosen.id }),
          garmentImageUrl: garment,
          category,
          ...(styleOptions && {
            ...(pose && { pose }),
            ...(expression && { expression }),
            ...(camera && { camera }),
            ...(background && { background }),
            ...(note.trim() && { note: note.trim() }),
          }),
        },
      });
      setMade((cur) => [r.image, ...cur]);
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
          Upload a photo of your dress and the AI makes a photo of a model wearing it. Every image is also saved in your Media library.
        </p>
        {setup.data && !setup.data.enabled && <Notice tone="warn">Making images with models is not switched on for Agently yet. It will be soon.</Notice>}
        {done && <Notice tone="ok">{done}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
        {setup.error && <Notice tone="error">{setup.error}</Notice>}

        <div className="tryon">
          <section className="card pad" aria-label="Upload your dress">
            <h2>Upload your dress</h2>
            <button type="button" className="garment" onClick={() => file.current?.click()} disabled={uploading}>
              {garment ? <img src={garment} alt="Your garment" /> : uploading ? 'Uploading…' : '+ Choose a photo of the garment'}
            </button>
            <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => pickGarment(e.target.files?.[0])} />
            <small className="muted">Best results: the whole garment, flat or on a hanger or mannequin, in good light, nothing covering it.</small>
            <label className="field">
              What is it?
              <select value={category} onChange={(e) => setCategory(e.target.value as Category)}>
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>

            <div className="gen-model">
              <label className="gen-check">
                <input type="checkbox" checked={useModel} onChange={(e) => setUseModel(e.target.checked)} />
                Use a model
              </label>
              {useModel && (
                <div className="gen-chosen">
                  {model ? (
                    <>
                      <img src={model.imageUrl} alt="" />
                      <span>
                        <strong>{model.name}</strong>
                        <small className="muted">{model.own ? 'Your model' : 'AI model'}</small>
                      </span>
                      <button type="button" className="btn sm light" onClick={() => setPicking(true)}>
                        Change
                      </button>
                    </>
                  ) : (
                    <button type="button" className="btn sm light" onClick={() => setPicking(true)} disabled={!setup.data}>
                      Show models
                    </button>
                  )}
                </div>
              )}
              {!useModel && styleOptions && <small className="muted">No model? Describe one in "Your own instructions" below and the AI creates one.</small>}
            </div>

            {styleOptions && (
              <fieldset className="style">
                <legend>Style (optional)</legend>
                <label className="field">
                  Pose
                  <select value={pose} onChange={(e) => setPose(e.target.value as Pose)}>
                    {POSES.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Expression
                  <select value={expression} onChange={(e) => setExpression(e.target.value as Expression)}>
                    {EXPRESSIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Camera
                  <select value={camera} onChange={(e) => setCamera(e.target.value as Camera)}>
                    {CAMERAS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Background
                  <select value={background} onChange={(e) => setBackground(e.target.value as Background)}>
                    {BACKGROUNDS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Your own instructions
                  <textarea
                    rows={3}
                    maxLength={MAX_NOTE}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder={
                      chosen
                        ? 'e.g. holding a small golden clutch, soft evening light, wearing gold earrings'
                        : 'Describe the model, e.g. a young Bangladeshi woman with long hair, smiling, standing in a garden'
                    }
                  />
                </label>
                <small className="muted">Write in English for best results. The garment is always copied as it is.</small>
              </fieldset>
            )}
            <button type="button" className="btn primary" disabled={!ready || starting || uploading || !setup.data?.enabled} onClick={generate}>
              {starting ? 'Starting…' : `Generate image${credits ? ` · ${credits} credits` : ''}`}
            </button>
            {!ready && (
              <small className="muted">
                {!garment
                  ? 'Upload the garment photo.'
                  : useModel && !model
                    ? 'Choose a model with Show models.'
                    : styleOptions
                      ? 'Use a model, or describe the model in your own instructions.'
                      : 'Use a model first.'}
              </small>
            )}
          </section>

          <section aria-label="Made here" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <h2 style={{ fontSize: 16 }}>Your new images</h2>
            {setup.loading && !setup.data && <Loading />}
            {made.length === 0 && (
              <Empty>
                Images you generate here show up here in about half a minute. Older ones are in the <Link href="/media">Media library</Link>.
              </Empty>
            )}
            <div className="results">
              {made.map((img) => (
                <div key={img.id} className="result">
                  <div className="ph">
                    {img.status === 'succeeded' && img.resultImageUrl ? (
                      <a href={img.resultImageUrl} target="_blank" rel="noreferrer">
                        <img src={img.resultImageUrl} alt="Model wearing your garment" />
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

      {picking && setup.data && (
        <ModelPicker
          models={setup.data.models}
          current={model}
          onClose={() => setPicking(false)}
          onPick={(m) => {
            setModel(m);
            setPicking(false);
          }}
        />
      )}
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
