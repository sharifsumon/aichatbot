'use client';

import { useEffect, useState } from 'react';
import { useAdmin } from '@/components/Shell';
import { Dialog, Empty, Loading, Notice, Pill, TopBar } from '@/components/ui';
import { useApi, useLoad, useUpload } from '@/lib/api';

type Gender = 'female' | 'male';
interface Model {
  id: string;
  name: string;
  gender: Gender;
  imageUrl: string;
  active: boolean;
  sortOrder: number;
}

const GENDER: Record<Gender, string> = { female: 'Woman', male: 'Man' };

/**
 * Model characters for "Generate product image with models". Every shop sees
 * the active ones and can have the AI dress them in the shop's own garments.
 */
export default function ModelsPage() {
  const api = useApi();
  const me = useAdmin();
  const edit = me.can('settings.manage');
  const list = useLoad<{ models: Model[] }>('/models');
  const [filter, setFilter] = useState<Gender | 'all'>('all');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Model>();
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();

  async function change(m: Model, body: Partial<Model>, message: string) {
    setError(undefined);
    try {
      await api(`/models/${m.id}`, { method: 'PATCH', body });
      setDone(message);
      list.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(m: Model) {
    if (!window.confirm(`Delete ${m.name}? Shops can no longer pick this model. Images already made stay in their catalogs.`)) return;
    setError(undefined);
    try {
      await api(`/models/${m.id}`, { method: 'DELETE' });
      setDone(`${m.name} deleted.`);
      list.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const models = (list.data?.models ?? []).filter((m) => filter === 'all' || m.gender === filter);

  return (
    <>
      <TopBar title="Model characters">
        {edit && (
          <button type="button" className="btn primary" onClick={() => setAdding(true)}>
            + Add a model
          </button>
        )}
      </TopBar>
      <div className="content">
        <p className="sub" style={{ margin: 0, fontSize: 14 }}>
          Shops pick one of these people in &ldquo;Generate product image with models&rdquo;, upload a garment photo, and the AI makes a photo of the model wearing it. Use sharp, full-length photos of one person standing straight, facing the camera, on a plain background, wearing simple fitted clothes.
        </p>
        {done && <Notice tone="ok">{done}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
        {list.error && <Notice tone="error">{list.error}</Notice>}
        <div className="chips" role="group" aria-label="Show">
          {(['all', 'female', 'male'] as const).map((g) => (
            <button key={g} type="button" className={`chip${filter === g ? ' on' : ''}`} aria-pressed={filter === g} onClick={() => setFilter(g)}>
              {{ all: 'All', female: 'Women', male: 'Men' }[g]}
            </button>
          ))}
        </div>
        {list.loading && !list.data && <Loading />}
        {list.data && models.length === 0 && <Empty>{edit ? 'No models yet. Add a few women and men for the shops to choose from.' : 'No models yet.'}</Empty>}
        <div className="models">
          {models.map((m) => (
            <div key={m.id} className={`model${m.active ? '' : ' off'}`}>
              <div className="ph">
                <img src={m.imageUrl} alt={m.name} loading="lazy" />
              </div>
              <div className="info">
                <div>
                  <strong>{m.name}</strong>
                  <span style={{ marginLeft: 'auto' }}>{m.active ? <Pill tone="green">{GENDER[m.gender]}</Pill> : <Pill>Hidden</Pill>}</span>
                </div>
                {edit && (
                  <div>
                    <button type="button" className="btn sm" onClick={() => setEditing(m)}>
                      Edit
                    </button>
                    <button type="button" className="btn sm" onClick={() => change(m, { active: !m.active }, m.active ? `${m.name} is hidden from shops.` : `${m.name} is shown to shops.`)}>
                      {m.active ? 'Hide' : 'Show'}
                    </button>
                    <button type="button" className="btn sm" style={{ color: 'var(--red)' }} onClick={() => remove(m)}>
                      Delete
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
      {adding && (
        <AddDialog
          onClose={() => setAdding(false)}
          onDone={(name) => {
            setAdding(false);
            setDone(`${name} added. Shops can pick this model now.`);
            list.reload();
          }}
        />
      )}
      {editing && (
        <EditDialog
          model={editing}
          onClose={() => setEditing(undefined)}
          onDone={() => {
            setEditing(undefined);
            setDone('Model saved.');
            list.reload();
          }}
        />
      )}
    </>
  );
}

function AddDialog({ onClose, onDone }: { onClose: () => void; onDone: (name: string) => void }) {
  const upload = useUpload();
  const [name, setName] = useState('');
  const [gender, setGender] = useState<Gender>('female');
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<string>();

  useEffect(() => {
    if (!file) return setPreview(undefined);
    const u = URL.createObjectURL(file);
    setPreview(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  return (
    <Dialog
      title="Add a model"
      submitLabel="Add model"
      onClose={onClose}
      onSubmit={async () => {
        if (!file) return 'Choose a photo of the model';
        if (file.size > 10 * 1024 * 1024) return 'A model photo can be at most 10 MB';
        await upload('/models', file, { name: name.trim(), gender });
        onDone(name.trim());
      }}
    >
      <label className="field">
        Name
        <input required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Nadia" />
        <small>Shops see this name in the picker.</small>
      </label>
      <label className="field">
        Woman or man
        <select value={gender} onChange={(e) => setGender(e.target.value as Gender)}>
          <option value="female">Woman</option>
          <option value="male">Man</option>
        </select>
      </label>
      <label className="field">
        Photo
        <input type="file" required accept="image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files?.[0])} />
        <small>JPEG, PNG or WebP, up to 10 MB. Full length, one person, plain background.</small>
      </label>
      {preview && <img className="preview" src={preview} alt="Preview" />}
    </Dialog>
  );
}

function EditDialog({ model, onClose, onDone }: { model: Model; onClose: () => void; onDone: () => void }) {
  const api = useApi();
  const [name, setName] = useState(model.name);
  const [gender, setGender] = useState<Gender>(model.gender);
  const [order, setOrder] = useState(String(model.sortOrder));
  return (
    <Dialog
      title={`Edit ${model.name}`}
      submitLabel="Save"
      onClose={onClose}
      onSubmit={async () => {
        await api(`/models/${model.id}`, { method: 'PATCH', body: { name: name.trim(), gender, sortOrder: Number.parseInt(order, 10) || 0 } });
        onDone();
      }}
    >
      <img className="preview" src={model.imageUrl} alt={model.name} />
      <label className="field">
        Name
        <input required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        Woman or man
        <select value={gender} onChange={(e) => setGender(e.target.value as Gender)}>
          <option value="female">Woman</option>
          <option value="male">Man</option>
        </select>
      </label>
      <label className="field">
        Order
        <input type="number" min={-1000} max={1000} value={order} onChange={(e) => setOrder(e.target.value)} />
        <small>Lower numbers come first in the shops&apos; picker.</small>
      </label>
    </Dialog>
  );
}
