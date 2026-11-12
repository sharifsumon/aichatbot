'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useShop } from '@/components/Shell';
import { AddToProduct } from '@/components/AddToProduct';
import { Chips, Empty, Loading, Notice, Pill, TopBar } from '@/components/ui';
import { ApiError, qs, useApi, useLoad, useUpload } from '@/lib/api';
import { shrinkImage } from '@/lib/image';

type Gender = 'female' | 'male';
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

/** Same limit as the API: product photos are at most 5 MB after shrinking. */
const MAX_PHOTO_MB = 5;

/**
 * Generate product image with models: pick a model, upload a garment photo,
 * and the AI makes a photo of the model wearing it, ready for the catalog.
 */
export default function ModelImagesPage() {
  const { ws, manager } = useShop();
  const api = useApi();
  const upload = useUpload();
  const router = useRouter();
  const setup = useLoad<{ models: Model[]; enabled: boolean; creditsPerImage: number; styleOptions?: boolean }>(`${ws}/try-on/models`);
  const [images, setImages] = useState<TryOnImage[]>();
  const [gender, setGender] = useState<Gender | 'all'>('all');
  const [model, setModel] = useState<Model>();
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const [adding, setAdding] = useState<TryOnImage>();
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

  return (
    <>
      <TopBar title="Product images with models" back={{ href: "/media", label: "Media library" }} />
      <div className="content tryon-page">
        <p className="sub" style={{ margin: 0, fontSize: 14 }}>
          Your models and the images you made with them. To make a new image, use Generate image.
        </p>
        {setup.data && !setup.data.enabled && <Notice tone="warn">Making images with models is not switched on for Agently yet. It will be soon.</Notice>}
        {done && <Notice tone="ok">{done}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
        {setup.error && <Notice tone="error">{setup.error}</Notice>}

        <div className="tryon tryon-one">
          <div className="tryon-col">
          <section className="card pad" aria-label="Choose a model">
            <div className="card-head">
              <h2>Models</h2>
              {!newModel && (
                <button type="button" className="btn sm light" onClick={() => setNewModel({ name: '', gender: gender === 'male' ? 'male' : 'female' })}>
                  + Add your own model
                </button>
              )}
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
            {setup.loading && !setup.data && <Loading />}
            {setup.data && models.length === 0 && !newModel && <Empty>No models to choose from yet. Add your own with the button above.</Empty>}
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
            {model && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Link href={`/generate-image?model=${model.id}`} className="btn sm primary">
                  Generate image with {model.name}
                </Link>
                {model.own && (
                  <button type="button" className="btn sm" onClick={() => removeModel(model)}>
                    Remove {model.name} from your models
                  </button>
                )}
              </div>
            )}
            {newModel && (
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

          <section aria-label="Your images" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <h2 style={{ fontSize: 16 }}>Your images</h2>
            {!images && <Loading />}
            {images?.length === 0 && <Empty>Images you make show up here. It takes about half a minute.</Empty>}
            <div className="results compact">
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
