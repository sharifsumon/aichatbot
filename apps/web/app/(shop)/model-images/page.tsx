'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useShop } from '@/components/Shell';
import { AddToProduct } from '@/components/AddToProduct';
import { Chips, Empty, Loading, Notice, Pill, TopBar } from '@/components/ui';
import { ApiError, qs, useApi, useLoad, useUpload } from '@/lib/api';
import { shrinkImage } from '@/lib/image';
import type { Product } from '@/lib/types';

type Gender = 'female' | 'male';
type Category = 'auto' | 'tops' | 'bottoms' | 'one-pieces';
interface Model {
  id: string;
  name: string;
  gender: Gender;
  imageUrl: string;
  /** The shop's own model, added from its own photo. */
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

/**
 * Generate product image with models: pick a model, upload a garment photo,
 * and the AI makes a photo of the model wearing it, ready for the catalog.
 */
export default function ModelImagesPage() {
  const { ws, manager, reloadHome } = useShop();
  const api = useApi();
  const upload = useUpload();
  const router = useRouter();
  const setup = useLoad<{ models: Model[]; enabled: boolean; creditsPerImage: number; styleOptions?: boolean }>(`${ws}/try-on/models`);
  const [images, setImages] = useState<TryOnImage[]>();
  const [gender, setGender] = useState<Gender | 'all'>('all');
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
  const file = useRef<HTMLInputElement>(null);
  const modelFile = useRef<HTMLInputElement>(null);
  const [newModel, setNewModel] = useState<{ imageUrl?: string; name: string; gender: Gender; busy?: boolean }>();

  // Opened from the Images panel: ?model=<id> picks that model, ?add=model opens "Add your own model".
  const models0 = setup.data?.models;
  useEffect(() => {
    if (!models0) return;
    const q = new URLSearchParams(window.location.search);
    const want = q.get('model');
    if (want) setModel(models0.find((m) => m.id === want));
    if (q.get('add') === 'model') setNewModel((m) => m ?? { name: '', gender: 'female' });
    if (want || q.get('add')) window.history.replaceState(null, '', window.location.pathname);
  }, [models0]);

  const loadImages = useCallback(async () => {
    try {
      const r = await api<{ images: TryOnImage[] }>(`${ws}/try-on`);
      setImages(r.images);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, ws]);

  useEffect(() => {
    loadImages();
  }, [loadImages]);

  // While an image is being made, check every few seconds.
  const pending = images?.some((i) => i.status === 'pending');
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(loadImages, 3000);
    return () => clearInterval(t);
  }, [pending, loadImages]);

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

  async function pickModelPhoto(f: File | undefined) {
    if (!f || !newModel) return;
    setNewModel({ ...newModel, busy: true });
    setError(undefined);
    try {
      const small = await shrinkImage(f);
      if (small.size > MAX_PHOTO_MB * 1024 * 1024) throw new Error(`The photo is larger than ${MAX_PHOTO_MB} MB. Use a smaller one.`);
      const r = await upload<{ url: string }>(`${ws}/uploads/images`, small, 60_000);
      setNewModel((m) => m && { ...m, imageUrl: r.url, busy: false });
    } catch (e) {
      setNewModel((m) => m && { ...m, busy: false });
      setError((e as ApiError).status === 503 ? 'Photo uploads are not switched on yet.' : (e as Error).message);
    } finally {
      if (modelFile.current) modelFile.current.value = '';
    }
  }

  async function saveModel() {
    if (!newModel?.imageUrl || !newModel.name.trim()) return;
    setNewModel({ ...newModel, busy: true });
    setError(undefined);
    try {
      const r = await api<{ model: Model }>(`${ws}/try-on/models`, { method: 'POST', body: { name: newModel.name.trim(), gender: newModel.gender, imageUrl: newModel.imageUrl } });
      setNewModel(undefined);
      setModel(r.model);
      setup.reload();
    } catch (e) {
      setNewModel((m) => m && { ...m, busy: false });
      setError((e as Error).message);
    }
  }

  async function removeModel(m: Model) {
    if (!window.confirm(`Remove ${m.name} from your models? Images already made with this model stay.`)) return;
    try {
      await api(`${ws}/try-on/models/${m.id}`, { method: 'DELETE' });
      if (model?.id === m.id) setModel(undefined);
      setup.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function generate() {
    if (!ready || !garment) return;
    setStarting(true);
    setError(undefined);
    setDone(undefined);
    try {
      const r = await api<{ image: TryOnImage }>(`${ws}/try-on`, { method: 'POST', body: {
          ...(model && { characterId: model.id }),
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
      setImages((cur) => [r.image, ...(cur ?? [])]);
      reloadHome();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  async function remove(img: TryOnImage) {
    if (!window.confirm('Remove this image from the list? If you added it to a product, it stays there.')) return;
    try {
      await api(`${ws}/try-on/${img.id}`, { method: 'DELETE' });
      setImages((cur) => cur?.filter((i) => i.id !== img.id));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!manager) {
    return (
      <>
        <TopBar title="Product images with models" back={{ href: "/media", label: "Media library" }} />
        <div className="content">
          <Notice tone="info">Only the shop owner and admins can make product images with models.</Notice>
        </div>
      </>
    );
  }

  const models = (setup.data?.models ?? []).filter((m) => gender === 'all' || m.gender === gender);
  const credits = setup.data?.creditsPerImage ?? 0;
  const styleOptions = setup.data?.styleOptions !== false;
  // Image models can create the model from the shop's description; FASHN needs a model photo.
  const ready = !!garment && (!!model || (styleOptions && !!note.trim()));

  return (
    <>
      <TopBar title="Product images with models" back={{ href: "/media", label: "Media library" }} />
      <div className="content">
        <p className="sub" style={{ margin: 0, fontSize: 14 }}>
          Pick a model, upload a photo of your dress, and the AI makes a photo of the model wearing it. Add the result to a product in your catalog.
        </p>
        {setup.data && !setup.data.enabled && <Notice tone="warn">Making images with models is not switched on for Agently yet. It will be soon.</Notice>}
        {done && <Notice tone="ok">{done}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
        {setup.error && <Notice tone="error">{setup.error}</Notice>}

        <div className="tryon">
          <section className="card pad" aria-label="Choose a model">
            <h2>1. Choose a model</h2>
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
            {setup.loading && !setup.data && <Loading />}
            {setup.data && models.length === 0 && !newModel && <Empty>No models to choose from yet. Add your own below.</Empty>}
            <div className="pick">
              {models.map((m) => (
                <button key={m.id} type="button" className={model?.id === m.id ? 'on' : ''} aria-pressed={model?.id === m.id} onClick={() => setModel(model?.id === m.id ? undefined : m)}>
                  <img src={m.imageUrl} alt="" loading="lazy" />
                  <span>
                    {m.name}
                    {m.own && ' · Yours'}
                  </span>
                </button>
              ))}
            </div>
            {styleOptions && (
              <small className="muted">Optional: skip this and describe the model in "Your own instructions" below, and the AI creates one. Tap a chosen model again to unselect it.</small>
            )}
            {model?.own && (
              <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => removeModel(model)}>
                Remove {model.name} from your models
              </button>
            )}
            {!newModel ? (
              <button type="button" className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => setNewModel({ name: '', gender: gender === 'male' ? 'male' : 'female' })}>
                + Add your own model
              </button>
            ) : (
              <fieldset className="style">
                <legend>Your own model</legend>
                <button type="button" className="garment" onClick={() => modelFile.current?.click()} disabled={newModel.busy}>
                  {newModel.imageUrl ? <img src={newModel.imageUrl} alt="Your model" /> : newModel.busy ? 'Uploading…' : '+ Choose a photo of the model'}
                </button>
                <input ref={modelFile} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => pickModelPhoto(e.target.files?.[0])} />
                <small className="muted">A clear, front-facing photo of one person, head to knees or full body, in good light. Use only photos you have permission to use.</small>
                <label className="field">
                  Name
                  <input value={newModel.name} maxLength={60} onChange={(e) => setNewModel({ ...newModel, name: e.target.value })} placeholder="e.g. Nusrat" />
                </label>
                <Chips
                  label="Model"
                  value={newModel.gender}
                  onChange={(g) => setNewModel({ ...newModel, gender: g })}
                  options={[
                    { value: 'female', label: 'Woman' },
                    { value: 'male', label: 'Man' },
                  ]}
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" className="btn primary" disabled={!newModel.imageUrl || !newModel.name.trim() || newModel.busy} onClick={saveModel}>
                    Save model
                  </button>
                  <button type="button" className="btn" onClick={() => setNewModel(undefined)}>
                    Cancel
                  </button>
                </div>
              </fieldset>
            )}
          </section>

          <section className="card pad" aria-label="Upload your garment">
            <h2>2. Upload your dress</h2>
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
                      model
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
                {!garment ? 'Upload the garment photo.' : styleOptions ? 'Choose a model, or describe the model in your own instructions.' : 'Choose a model first.'}
              </small>
            )}
          </section>
        </div>

        <section aria-label="Your images" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h2 style={{ fontSize: 16 }}>Your images</h2>
          {!images && <Loading />}
          {images?.length === 0 && <Empty>Images you make show up here. It takes about half a minute.</Empty>}
          <div className="results">
            {images?.map((img) => (
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
                  <div className="thumbs" aria-hidden="true">
                    {img.modelImageUrl && <img src={img.modelImageUrl} alt="" />}
                    <img src={img.garmentImageUrl} alt="" />
                  </div>
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
                  {img.status !== 'pending' && (
                    <button type="button" className="btn sm link" style={{ marginLeft: 'auto' }} onClick={() => remove(img)}>
                      Remove
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
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
