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
    <main className="home">
      <section className="home-hero" aria-label="About Agently">
        <div className="home-brand">
          <Icon.logoLight />
          Agently
        </div>
        <div className="home-pitch">
          <h1>
            Your Facebook page, <em>answered day and night.</em> No coding needed.
          </h1>
          <p>
            Agently replies to messages and comments in Bangla or English, takes orders and collects bKash, Nagad or cash on delivery, all from one
            simple dashboard.
          </p>
          <div className="home-stats">
            <div>
              <strong>24/7</strong>
              <span>Replies, day and night</span>
            </div>
            <div>
              <strong>2 min</strong>
              <span>To connect your page</span>
            </div>
            <div>
              <strong>14 days</strong>
              <span>Free trial, no card</span>
            </div>
          </div>
        </div>
      </section>

      <section className="home-sign" aria-label="Sign in">
        <div className="home-box">
          <div className="home-brand mobile">
            <Icon.logo />
            Agently
          </div>
          <h2>Welcome to Agently</h2>
          <p className="muted">Sign in to set up your AI sales assistant</p>
          {error && <Notice tone="error">{ERRORS[error] ?? 'Sign-in did not work. Please try again.'}</Notice>}
          {problem && <Notice tone="error">{problem}</Notice>}
          <a className="btn home-fb" href={`${base}/auth/facebook`}>
            <Icon.facebook />
            Continue with Facebook
          </a>
          <div className="home-tip">
            <strong>Good to know:</strong> we use Facebook to sign you in and to find the pages you manage. We never post without your say, and you can take
            over any chat at any time.
          </div>
          <p className="home-legal">
            By continuing you agree to our <a href="/privacy">privacy policy</a>.
          </p>
        </div>
      </section>
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
