'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Dialog, Empty, Loading, Notice, Pill, TopBar } from '@/components/ui';
import { useApi, useLoad } from '@/lib/api';
import type { Plan } from '@/lib/types';

interface TopUp {
  credits: number;
  priceBdt: string;
  priceUsd: string;
}
interface Settings {
  'ai.defaultModel'?: string;
  'ai.fallbackModel'?: string | null;
  'ai.defaultSystemInstruction'?: string;
  'credits.topUp'?: TopUp;
  'tryon.creditsPerImage'?: number;
}
interface Flag {
  id: string;
  key: string;
  enabled: boolean;
  workspaceId: string | null;
  planKey: string | null;
}

export default function SettingsPage() {
  const api = useApi();
  const settings = useLoad<{ settings: Settings }>('/settings');
  const flags = useLoad<{ flags: Flag[] }>('/flags');
  const plans = useLoad<{ plans: Plan[] }>('/plans');
  const [model, setModel] = useState('');
  const [fallback, setFallback] = useState('');
  const [instruction, setInstruction] = useState('');
  const [topUp, setTopUp] = useState({ credits: '', priceBdt: '', priceUsd: '' });
  const [tryOnCredits, setTryOnCredits] = useState('');
  const [saving, setSaving] = useState<string>();
  const [done, setDone] = useState<string>();
  const [error, setError] = useState<string>();
  const [newFlag, setNewFlag] = useState(false);

  useEffect(() => {
    const s = settings.data?.settings;
    if (!s) return;
    setModel(s['ai.defaultModel'] ?? '');
    setFallback(s['ai.fallbackModel'] ?? '');
    setInstruction(s['ai.defaultSystemInstruction'] ?? '');
    setTryOnCredits(String(s['tryon.creditsPerImage'] ?? 10));
    const t = s['credits.topUp'];
    setTopUp({ credits: t ? String(t.credits) : '', priceBdt: t ? String(t.priceBdt) : '', priceUsd: t ? String(t.priceUsd) : '' });
  }, [settings.data]);

  async function save(key: string, value: unknown, label: string) {
    setSaving(key);
    setError(undefined);
    setDone(undefined);
    try {
      await api(`/settings/${encodeURIComponent(key)}`, { method: 'PUT', body: { value } });
      setDone(`${label} saved.`);
      settings.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(undefined);
    }
  }

  const submit = (key: string, value: () => unknown, label: string) => (e: FormEvent) => {
    e.preventDefault();
    save(key, value(), label);
  };

  async function toggle(f: Flag) {
    setError(undefined);
    try {
      await api('/flags', { method: 'PUT', body: { key: f.key, enabled: !f.enabled, workspaceId: f.workspaceId, planKey: f.planKey } });
      flags.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <TopBar title="Platform settings" />
      <div className="content">
        {done && <Notice tone="ok">{done}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
        {settings.error && <Notice tone="error">{settings.error}</Notice>}
        {settings.loading && !settings.data && <Loading />}
        {settings.data && (
          <div className="grid2">
            <form className="card pad" onSubmit={submit('ai.defaultModel', () => model.trim(), 'Default model')} aria-label="AI model">
              <h2>AI model</h2>
              <p className="sub" style={{ margin: 0 }}>
                Leave empty to use AI_CHAT_MODEL from the server&apos;s settings file.
              </p>
              <label className="field">
                Default model
                <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-4o-mini" />
              </label>
              <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={saving === 'ai.defaultModel' || !model.trim()}>
                Save model
              </button>
              <label className="field" style={{ marginTop: 8 }}>
                Fallback model
                <input value={fallback} onChange={(e) => setFallback(e.target.value)} placeholder="None" />
                <small>Used when the default model fails.</small>
              </label>
              <button type="button" className="btn" style={{ alignSelf: 'flex-start' }} disabled={saving === 'ai.fallbackModel'} onClick={() => save('ai.fallbackModel', fallback.trim() || null, 'Fallback model')}>
                Save fallback
              </button>
            </form>

            <form
              className="card pad"
              aria-label="Credit top-up"
              onSubmit={submit('credits.topUp', () => ({ credits: Number.parseInt(topUp.credits, 10), priceBdt: topUp.priceBdt.trim(), priceUsd: topUp.priceUsd.trim() }), 'Credit top-up')}
            >
              <h2>Credit top-up pack</h2>
              <p className="sub" style={{ margin: 0 }}>
                What a shop gets when it buys extra AI credits.
              </p>
              <div className="row">
                <label className="field">
                  Credits
                  <input type="number" min={1} required value={topUp.credits} onChange={(e) => setTopUp((t) => ({ ...t, credits: e.target.value }))} />
                </label>
                <label className="field">
                  Price (৳)
                  <input required inputMode="decimal" value={topUp.priceBdt} onChange={(e) => setTopUp((t) => ({ ...t, priceBdt: e.target.value }))} />
                </label>
                <label className="field">
                  Price ($)
                  <input required inputMode="decimal" value={topUp.priceUsd} onChange={(e) => setTopUp((t) => ({ ...t, priceUsd: e.target.value }))} />
                </label>
              </div>
              <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={saving === 'credits.topUp'}>
                Save top-up
              </button>
            </form>

            <form
              className="card pad"
              aria-label="Product images with models"
              onSubmit={submit('tryon.creditsPerImage', () => Number.parseInt(tryOnCredits, 10), 'Credits per image')}
            >
              <h2>Product images with models</h2>
              <p className="sub" style={{ margin: 0 }}>
                AI credits a shop uses for each image of a <a href="/models">model character</a> wearing its garment. One credit is one AI reply; a try-on image costs the platform far more than a reply.
              </p>
              <label className="field">
                Credits per image
                <input type="number" min={0} max={1000} required value={tryOnCredits} onChange={(e) => setTryOnCredits(e.target.value)} />
              </label>
              <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={saving === 'tryon.creditsPerImage'}>
                Save
              </button>
            </form>

            <TryOnServiceCard />

            <form className="card pad" onSubmit={submit('ai.defaultSystemInstruction', () => instruction, 'Default instruction')} aria-label="Default instruction" style={{ gridColumn: '1 / -1' }}>
              <h2>Default bot instruction</h2>
              <p className="sub" style={{ margin: 0 }}>
                Added to every shop&apos;s bot before the shop&apos;s own instructions. Keep it short.
              </p>
              <label className="field">
                <span className="sr">Instruction</span>
                <textarea rows={6} maxLength={4000} value={instruction} onChange={(e) => setInstruction(e.target.value)} />
              </label>
              <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={saving === 'ai.defaultSystemInstruction'}>
                Save instruction
              </button>
            </form>
          </div>
        )}

        <section aria-label="Feature flags" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <h2 style={{ fontSize: 16 }}>Feature flags</h2>
            <button type="button" className="btn" style={{ marginLeft: 'auto' }} onClick={() => setNewFlag(true)}>
              + Set a flag
            </button>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Flag</th>
                  <th>Applies to</th>
                  <th>State</th>
                  <th>
                    <span className="sr">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {flags.data?.flags.map((f) => (
                  <tr key={f.id}>
                    <td>
                      <code>{f.key}</code>
                    </td>
                    <td>{f.workspaceId ? <a href={`/tenants/${f.workspaceId}`}>One shop</a> : f.planKey ? `Plan: ${f.planKey}` : 'Everyone'}</td>
                    <td>{f.enabled ? <Pill tone="green">On</Pill> : <Pill>Off</Pill>}</td>
                    <td>
                      <button type="button" className="btn sm" onClick={() => toggle(f)}>
                        Turn {f.enabled ? 'off' : 'on'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {flags.loading && <Loading />}
            {flags.data && flags.data.flags.length === 0 && <Empty>No flags set.</Empty>}
          </div>
        </section>
      </div>
      {newFlag && <FlagDialog plans={plans.data?.plans ?? []} onClose={() => setNewFlag(false)} onDone={() => (setNewFlag(false), flags.reload())} />}
    </>
  );
}

function FlagDialog({ plans, onClose, onDone }: { plans: Plan[]; onClose: () => void; onDone: () => void }) {
  const api = useApi();
  const [key, setKey] = useState('');
  const [scope, setScope] = useState<'all' | 'plan' | 'shop'>('all');
  const [planKey, setPlanKey] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [enabled, setEnabled] = useState(true);
  return (
    <Dialog
      title="Set a feature flag"
      submitLabel="Save flag"
      onClose={onClose}
      onSubmit={async () => {
        await api('/flags', {
          method: 'PUT',
          body: { key: key.trim(), enabled, planKey: scope === 'plan' ? planKey : null, workspaceId: scope === 'shop' ? workspaceId.trim() : null },
        });
        onDone();
      }}
    >
      <label className="field">
        Flag key
        <input required pattern="[a-z0-9_.\-]{2,60}" placeholder="e.g. whatsapp.beta" value={key} onChange={(e) => setKey(e.target.value)} />
      </label>
      <label className="field">
        Applies to
        <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
          <option value="all">Everyone</option>
          <option value="plan">One plan</option>
          <option value="shop">One shop</option>
        </select>
      </label>
      {scope === 'plan' && (
        <label className="field">
          Plan
          <select required value={planKey} onChange={(e) => setPlanKey(e.target.value)}>
            <option value="">Choose a plan</option>
            {plans.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {scope === 'shop' && (
        <label className="field">
          Shop id
          <input required value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} placeholder="From the shop's tenant page" />
        </label>
      )}
      <label className="check">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        On
      </label>
    </Dialog>
  );
}

interface TryOnService {
  provider: 'fashn' | 'gemini' | 'fal';
  model: string;
  mode: string;
  costPerImageUsd: number | null;
  apiKeyLast4: string | null;
  source: 'settings' | 'server' | 'off';
  active: { provider: string; model: string | null } | null;
}

const SERVICE_HELP: Record<TryOnService['provider'], { name: string; model: string; cost: string; keyUrl: string }> = {
  fashn: { name: 'FASHN (built for clothes)', model: 'tryon-v1.6', cost: '0.075', keyUrl: 'https://app.fashn.ai/api' },
  gemini: { name: 'Google Gemini image', model: 'gemini-2.5-flash-image', cost: '0.039', keyUrl: 'https://aistudio.google.com/apikey' },
  fal: { name: 'fal.ai (Nano Banana)', model: 'fal-ai/nano-banana/edit', cost: '0.0398', keyUrl: 'https://fal.ai/dashboard/keys' },
};

/** The try-on AI service and its API key. The key is write-only: only its last 4 characters come back. */
function TryOnServiceCard() {
  const api = useApi();
  const load = useLoad<{ service: TryOnService }>('/tryon-service');
  const [provider, setProvider] = useState<TryOnService['provider']>('fashn');
  const [model, setModel] = useState('');
  const [mode, setMode] = useState('');
  const [cost, setCost] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string }>();

  useEffect(() => {
    const s = load.data?.service;
    if (!s) return;
    setProvider(s.provider);
    setModel(s.model);
    setMode(s.mode);
    setCost(s.costPerImageUsd == null ? '' : String(s.costPerImageUsd));
  }, [load.data]);

  async function save(removeKey = false) {
    setBusy(true);
    setNote(undefined);
    try {
      await api('/tryon-service', {
        method: 'PUT',
        body: {
          provider,
          model: model.trim(),
          mode: provider === 'fashn' ? mode : '',
          costPerImageUsd: cost.trim() ? Number(cost) : null,
          ...(removeKey ? { apiKey: '' } : apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        },
      });
      setApiKey('');
      setNote({ tone: 'ok', text: removeKey ? 'API key removed.' : 'Try-on service saved. Shops use it from their next image.' });
      load.reload();
    } catch (e) {
      setNote({ tone: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const s = load.data?.service;
  const help = SERVICE_HELP[provider];
  return (
    <form
      className="card pad"
      aria-label="Try-on AI service"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <h2>Try-on AI service</h2>
      <p className="sub" style={{ margin: 0 }}>
        The AI that dresses the model characters in the shops&apos; garments.{' '}
        {s?.source === 'settings' && s.active && `Now using ${SERVICE_HELP[s.active.provider as TryOnService['provider']]?.name ?? s.active.provider} with the key saved here.`}
        {s?.source === 'server' && s.active && `Now using ${s.active.provider} (${s.active.model}) from the server's .env file. A key saved here takes over.`}
        {s?.source === 'off' && 'Switched off: add an API key to turn it on for every shop.'}
      </p>
      {load.error && <Notice tone="error">{load.error}</Notice>}
      <label className="field">
        Service
        <select
          value={provider}
          onChange={(e) => {
            // A model name belongs to one service; switching starts from that service's default.
            setProvider(e.target.value as TryOnService['provider']);
            setModel('');
          }}
        >
          <option value="fashn">{SERVICE_HELP.fashn.name}</option>
          <option value="gemini">{SERVICE_HELP.gemini.name}</option>
          <option value="fal">{SERVICE_HELP.fal.name}</option>
        </select>
      </label>
      <div className="row">
        <label className="field" style={{ flex: '2 1 160px' }}>
          Model
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder={help.model} maxLength={120} />
          <small>
            Empty uses {help.model}.
            {provider === 'fal' && ' Better: fal-ai/nano-banana-2/edit ($0.08) or fal-ai/nano-banana-pro/edit ($0.15).'}
          </small>
        </label>
        {provider === 'fashn' && (
          <label className="field">
            Quality
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="">Best (quality)</option>
              <option value="balanced">Balanced</option>
              <option value="performance">Fastest</option>
            </select>
          </label>
        )}
      </div>
      <label className="field">
        API key
        <input
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={s?.apiKeyLast4 ? `Saved: ••••${s.apiKeyLast4} (type to replace)` : 'Paste the API key'}
        />
        <small>
          Stored encrypted and never shown again. Get one at{' '}
          <a href={help.keyUrl} target="_blank" rel="noreferrer">
            {new URL(help.keyUrl).host}
          </a>
          .
        </small>
      </label>
      <label className="field">
        Cost per image ($)
        <input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder={help.cost} />
        <small>For the AI usage page. Empty uses {help.cost}.</small>
      </label>
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary" disabled={busy || (!apiKey.trim() && !s?.apiKeyLast4 && s?.source !== 'server')}>
          Save service
        </button>
        {s?.apiKeyLast4 && (
          <button type="button" className="btn" disabled={busy} onClick={() => window.confirm('Remove the saved API key? Shops fall back to the server key, or the feature switches off.') && save(true)}>
            Remove key
          </button>
        )}
      </div>
    </form>
  );
}
