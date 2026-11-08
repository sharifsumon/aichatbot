'use client';

import { useRouter } from 'next/navigation';
import QRCode from 'qrcode';
import { useEffect, useState, type FormEvent } from 'react';
import { Notice } from '@/components/ui';
import { useApi } from '@/lib/api';

type Step = { kind: 'password' } | { kind: 'code' } | { kind: 'setup'; secret: string; qr: string };

/** Email and password, then a code from an authenticator app (set up on the first sign-in). */
export default function LoginPage() {
  const api = useApi();
  const router = useRouter();
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  // Already signed in: straight to the panel.
  useEffect(() => {
    api('/auth/me')
      .then(() => router.replace('/'))
      .catch(() => undefined);
  }, [api, router]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function signIn(e: FormEvent) {
    e.preventDefault();
    run(async () => {
      const r = await api<{ next: 'totp' } | { next: 'totp_setup'; secret: string; otpauthUrl: string }>('/auth/login', { method: 'POST', body: { email, password } });
      setPassword('');
      if (r.next === 'totp_setup') {
        setStep({ kind: 'setup', secret: r.secret, qr: await QRCode.toDataURL(r.otpauthUrl, { margin: 1, width: 200 }) });
      } else {
        setStep({ kind: 'code' });
      }
    });
  }

  function verify(e: FormEvent) {
    e.preventDefault();
    run(async () => {
      await api('/auth/totp', { method: 'POST', body: { code: code.replace(/\s/g, '') } });
      router.replace('/');
    });
  }

  return (
    <div className="auth">
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#4F46E5" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z" />
          </svg>
          <h1>Agently admin</h1>
        </div>

        {step.kind === 'password' && (
          <form onSubmit={signIn} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <p className="muted" style={{ margin: 0 }}>
              For the Agently team only. Shop owners sign in at the main site.
            </p>
            <label className="field">
              Email
              <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="field">
              Password
              <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            {error && <Notice tone="error">{error}</Notice>}
            <button className="btn primary" disabled={busy}>
              {busy ? 'Checking…' : 'Continue'}
            </button>
          </form>
        )}

        {step.kind !== 'password' && (
          <form onSubmit={verify} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {step.kind === 'setup' ? (
              <>
                <p style={{ margin: 0 }}>
                  <strong>Set up two-step sign-in.</strong> Scan this code with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password and so on), then type the 6-digit code it shows.
                </p>
                <img className="qr" src={step.qr} alt="QR code for your authenticator app" width={200} height={200} />
                <span className="sub">Can&apos;t scan? Enter this key in the app instead:</span>
                <span className="secret">{step.secret}</span>
              </>
            ) : (
              <p style={{ margin: 0 }}>Type the 6-digit code from your authenticator app.</p>
            )}
            <label className="field">
              Code
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9 ]{6,8}"
                maxLength={8}
                required
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </label>
            {error && <Notice tone="error">{error}</Notice>}
            <button className="btn primary" disabled={busy}>
              {busy ? 'Checking…' : 'Sign in'}
            </button>
            <button
              type="button"
              className="btn link"
              onClick={() => {
                setStep({ kind: 'password' });
                setCode('');
                setError(undefined);
              }}
            >
              Start again
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
