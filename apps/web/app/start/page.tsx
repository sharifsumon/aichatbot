'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Icon } from '@/components/icons';
import { rememberShop } from '@/components/Shell';
import { Loading, Notice } from '@/components/ui';
import { ApiError, useApi } from '@/lib/api';
import type { Me } from '@/lib/types';
import { PagePicker } from '@/components/PagePicker';

type Step = 'name' | 'page' | 'payments' | 'done';
const ORDER: Step[] = ['name', 'page', 'payments', 'done'];

/** First run: name the shop, connect a Facebook page, set how customers pay. */
export default function StartPage() {
  const api = useApi();
  const [me, setMe] = useState<Me>();
  const [step, setStep] = useState<Step>('name');
  const [shopId, setShopId] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api<Me>('/me')
      .then(setMe)
      .catch((e: ApiError) => (e.status === 401 ? (window.location.href = '/') : setError(e.message)));
  }, [api]);

  if (!me) return <div className="wizard">{error ? <Notice tone="error">{error}</Notice> : <Loading />}</div>;

  return (
    <main className="wizard">
      <div className="brand" style={{ padding: 0 }}>
        <Icon.logo />
        Agently
      </div>
      <div className="progress" aria-hidden="true">
        {ORDER.map((s, i) => (
          <div key={s} className={i <= ORDER.indexOf(step) ? 'on' : ''} />
        ))}
      </div>
      {step === 'name' && (
        <NameStep
          me={me}
          onDone={(id) => {
            rememberShop(id);
            setShopId(id);
            setStep('page');
          }}
        />
      )}
      {step === 'page' && shopId && <PageStep shopId={shopId} onDone={() => setStep('payments')} />}
      {step === 'payments' && shopId && <PaymentsStep shopId={shopId} onDone={() => setStep('done')} />}
      {step === 'done' && (
        <section className="card">
          <h1>You are set up</h1>
          <p className="muted" style={{ margin: 0 }}>
            Next, add the products you sell, so the bot can quote prices and stock. Then switch the bot on from your dashboard.
          </p>
          <div className="row">
            <a className="btn primary" href="/catalog">
              Add products
            </a>
            <a className="btn" href="/dashboard">
              Go to the dashboard
            </a>
          </div>
        </section>
      )}
    </main>
  );
}

function NameStep({ me, onDone }: { me: Me; onDone: (id: string) => void }) {
  const api = useApi();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const r = await api<{ workspace: { id: string } }>('/workspaces', { method: 'POST', body: { name } });
      onDone(r.workspace.id);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h1>{me.workspaces.length ? 'Add another shop' : `Welcome, ${me.user.name.split(' ')[0]}`}</h1>
      <p className="muted" style={{ margin: 0 }}>
        What is your shop called? Customers see this name when the bot introduces itself.
      </p>
      <label className="field">
        Shop name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Dhaka Style" minLength={2} maxLength={80} required autoFocus />
      </label>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="row">
        <button type="submit" className="btn primary" disabled={busy || name.trim().length < 2}>
          {busy ? 'Creating…' : 'Start my free trial'}
        </button>
        {me.workspaces.length > 0 && (
          <a className="btn" href="/dashboard">
            Cancel
          </a>
        )}
      </div>
    </form>
  );
}

function PageStep({ shopId, onDone }: { shopId: string; onDone: () => void }) {
  return (
    <section className="card">
      <h1>Connect your Facebook page</h1>
      <p className="muted" style={{ margin: 0 }}>
        The bot answers messages and comments on the page you pick. You can change this later in Settings.
      </p>
      <PagePicker shopId={shopId} onConnected={onDone} />
      <button type="button" className="btn link" style={{ alignSelf: 'flex-start' }} onClick={onDone}>
        Skip for now
      </button>
    </section>
  );
}

function PaymentsStep({ shopId, onDone }: { shopId: string; onDone: () => void }) {
  const api = useApi();
  const [bkash, setBkash] = useState('');
  const [nagad, setNagad] = useState('');
  const [cod, setCod] = useState(true);
  const [inside, setInside] = useState('60');
  const [outside, setOutside] = useState('120');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      setBusy(true);
      setError(undefined);
      try {
        await api(`/workspaces/${shopId}/settings`, {
          method: 'PATCH',
          body: { bkashNumber: bkash || null, nagadNumber: nagad || null, codEnabled: cod, deliveryChargeInsideDhaka: inside, deliveryChargeOutsideDhaka: outside },
        });
        onDone();
      } catch (err) {
        setError((err as Error).message);
        setBusy(false);
      }
    },
    [api, shopId, bkash, nagad, cod, inside, outside, onDone],
  );

  return (
    <form className="card" onSubmit={submit}>
      <h1>How do customers pay?</h1>
      <p className="muted" style={{ margin: 0 }}>
        The bot offers only what you switch on. For bKash and Nagad it sends your number and the amount, then asks for the transaction ID.
      </p>
      <label className="check">
        <input type="checkbox" checked={cod} onChange={(e) => setCod(e.target.checked)} /> Cash on delivery
      </label>
      <div className="row">
        <label className="field">
          bKash number
          <input value={bkash} onChange={(e) => setBkash(e.target.value)} placeholder="01XXXXXXXXX" inputMode="tel" />
        </label>
        <label className="field">
          Nagad number
          <input value={nagad} onChange={(e) => setNagad(e.target.value)} placeholder="01XXXXXXXXX" inputMode="tel" />
        </label>
      </div>
      <div className="row">
        <label className="field">
          Delivery inside Dhaka (৳)
          <input value={inside} onChange={(e) => setInside(e.target.value)} inputMode="decimal" required />
        </label>
        <label className="field">
          Delivery outside Dhaka (৳)
          <input value={outside} onChange={(e) => setOutside(e.target.value)} inputMode="decimal" required />
        </label>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="row">
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save and continue'}
        </button>
        <button type="button" className="btn" onClick={onDone}>
          Skip for now
        </button>
      </div>
    </form>
  );
}
