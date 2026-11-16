'use client';

import { useEffect, useRef, useState } from 'react';
import { Notice } from '@/components/ui';
import { ApiError, useApi, useUpload } from '@/lib/api';
import { shrinkImage } from '@/lib/image';

/** Same limit as the API: photos are at most 5 MB after shrinking. */
const MAX_PHOTO_MB = 5;

/** "Add new model" popup: upload a photo of the shop's own model, name it, save. */
export function AddModelDialog({ ws, onClose, onSaved }: { ws: string; onClose: () => void; onSaved: () => void }) {
  const api = useApi();
  const upload = useUpload();
  const file = useRef<HTMLInputElement>(null);
  const [imageUrl, setImageUrl] = useState<string>();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  async function pick(f: File | undefined) {
    if (!f) return;
    setBusy(true);
    setError(undefined);
    try {
      const small = await shrinkImage(f);
      if (small.size > MAX_PHOTO_MB * 1024 * 1024) throw new Error(`The photo is larger than ${MAX_PHOTO_MB} MB. Use a smaller one.`);
      const r = await upload<{ url: string }>(`${ws}/uploads/images`, small, 60_000);
      setImageUrl(r.url);
    } catch (e) {
      setError((e as ApiError).status === 503 ? 'Photo uploads are not switched on yet.' : (e as Error).message);
    } finally {
      setBusy(false);
      if (file.current) file.current.value = '';
    }
  }

  async function save() {
    if (!imageUrl || !name.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      await api(`${ws}/try-on/models`, { method: 'POST', body: { name: name.trim(), imageUrl } });
      onSaved();
    } catch (e) {
      setBusy(false);
      setError((e as Error).message);
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog add-model" role="dialog" aria-modal="true" aria-label="Add new model">
        <h2>Add new model</h2>
        {error && <Notice tone="error">{error}</Notice>}
        <button type="button" className="garment" onClick={() => file.current?.click()} disabled={busy}>
          {imageUrl ? <img src={imageUrl} alt="Your model" /> : busy ? 'Uploading…' : '+ Choose a photo of the model'}
        </button>
        <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => pick(e.target.files?.[0])} />
        <small className="muted">A clear, front-facing photo of one person, head to knees or full body, in good light. Use only photos you have permission to use.</small>
        <label className="field">
          Name
          <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. Nusrat" />
        </label>
        <div className="buttons">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={!imageUrl || !name.trim() || busy} onClick={save}>
            {busy && imageUrl ? 'Saving…' : 'Save model'}
          </button>
        </div>
      </div>
    </div>
  );
}
