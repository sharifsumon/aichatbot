'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Icon } from '@/components/icons';
import { Loading, Notice } from '@/components/ui';
import { ApiError, useApi, useApiBase } from '@/lib/api';
import { INVITE_KEY, readOnce } from '@/lib/storage';
import type { Me } from '@/lib/types';

const ERRORS: Record<string, string> = {
  facebook_cancelled: 'Facebook sign-in was cancelled. Try again when you are ready.',
  facebook_state: 'That sign-in link expired. Please try again.',
  facebook_failed: 'Facebook did not let us sign you in. Please try again in a minute.',
};

/** Signed out: "Continue with Facebook". Signed in: straight to the dashboard, onboarding or a waiting invite. */
function Gate() {
  const api = useApi();
  const base = useApiBase();
  const router = useRouter();
  const error = useSearchParams().get('error');
  const [state, setState] = useState<'checking' | 'signed-out' | 'error'>('checking');
  const [problem, setProblem] = useState<string>();

  useEffect(() => {
    api<Me>('/me')
      .then((me) => {
        const invite = readOnce(INVITE_KEY);
        if (invite) router.replace(`/invite/${invite}`);
        else router.replace(me.workspaces.length ? '/dashboard' : '/start');
      })
      .catch((e: ApiError) => {
        if (e.status === 401) setState('signed-out');
        else {
          setProblem(e.message);
          setState('error');
        }
      });
  }, [api, router]);

  if (state === 'checking') return <div className="auth"><Loading /></div>;

  return (
    <main className="auth">
      <div className="card" style={{ maxWidth: 460 }}>
        <div className="brand" style={{ padding: 0 }}>
          <Icon.logo />
          Agently
        </div>
        <div className="hero">
          <h1>Your Facebook page, answered day and night</h1>
          <p>Agently replies to messages and comments in Bangla or English, takes orders, and collects bKash, Nagad or cash on delivery.</p>
        </div>
        <ul className="ticks">
          <li>14-day free trial, no card needed</li>
          <li>Connect your page in two minutes</li>
          <li>You can take over any chat at any time</li>
        </ul>
        {error && <Notice tone="error">{ERRORS[error] ?? 'Sign-in did not work. Please try again.'}</Notice>}
        {problem && <Notice tone="error">{problem}</Notice>}
        <a className="btn fb" href={`${base}/auth/facebook`}>
          Continue with Facebook
        </a>
        <p className="sub" style={{ margin: 0 }}>
          We use Facebook to sign you in and to find the pages you manage. We never post without your say. See our{' '}
          <a href="/privacy">privacy policy</a>.
        </p>
      </div>
    </main>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div className="auth"><Loading /></div>}>
      <Gate />
    </Suspense>
  );
}
