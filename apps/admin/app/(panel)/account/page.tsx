'use client';

import { useState, type FormEvent } from 'react';
import { useAdmin } from '@/components/Shell';
import { Notice, TopBar } from '@/components/ui';
import { useApi } from '@/lib/api';
import { ROLE_LABEL } from '@/lib/types';

export default function AccountPage() {
  const me = useAdmin();
  const api = useApi();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    setDone(false);
    if (next !== again) return setError('The two new passwords are different.');
    setBusy(true);
    try {
      await api('/auth/password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
      setCurrent('');
      setNext('');
      setAgain('');
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <TopBar title="Your account" />
      <div className="content">
        <section className="card pad" style={{ maxWidth: 520 }}>
          <h2>{me.name}</h2>
          <span className="muted">
            {me.email} · {ROLE_LABEL[me.role]}
          </span>
        </section>
        <form className="card pad" style={{ maxWidth: 520 }} onSubmit={submit}>
          <h2>Change your password</h2>
          <p className="sub" style={{ margin: 0 }}>
            This signs you out everywhere else.
          </p>
          <label className="field">
            Current password
            <input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
          </label>
          <label className="field">
            New password
            <input type="password" autoComplete="new-password" required minLength={12} value={next} onChange={(e) => setNext(e.target.value)} />
            <small>At least 12 characters.</small>
          </label>
          <label className="field">
            New password again
            <input type="password" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} />
          </label>
          {error && <Notice tone="error">{error}</Notice>}
          {done && <Notice tone="ok">Your password is changed.</Notice>}
          <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={busy}>
            {busy ? 'Saving…' : 'Change password'}
          </button>
        </form>
      </div>
    </>
  );
}
