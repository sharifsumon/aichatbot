'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Loading, Notice, Pill } from '@/components/ui';
import { ApiError, useApi, useApiBase } from '@/lib/api';
import type { ChannelUsage } from '@/lib/types';

interface IgAccount {
  id: string;
  username: string;
  pageName: string;
  canMessage: boolean;
  connected: 'this_workspace' | 'other_workspace' | null;
}

/** Instagram professional accounts linked to the person's Facebook pages, with a Connect button on each. */
export function InstagramPicker({ shopId, onConnected }: { shopId: string; onConnected?: (name: string, hasAgent: boolean) => void }) {
  const api = useApi();
  const base = useApiBase();
  const [accounts, setAccounts] = useState<IgAccount[]>();
  const [reconnect, setReconnect] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const signIn = `${base}/auth/facebook?with=instagram`;

  const load = useCallback(() => {
    setError(undefined);
    api<{ accounts: IgAccount[] }>(`/workspaces/${shopId}/instagram/accounts`)
      .then((r) => setAccounts(r.accounts))
      .catch((e: ApiError) => {
        if (e.status === 409) setReconnect(true);
        else setError(e.message);
        setAccounts([]);
      });
  }, [api, shopId]);

  useEffect(load, [load]);

  async function connect(a: IgAccount) {
    setBusy(a.id);
    setError(undefined);
    try {
      const r = await api<{ channel: { name: string; hasAgent: boolean } }>(`/workspaces/${shopId}/instagram/accounts/${a.id}/connect`, { method: 'POST' });
      onConnected?.(r.channel.name, r.channel.hasAgent);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  if (!accounts) return <Loading what="Finding your Instagram accounts" />;
  if (reconnect) {
    return (
      <Notice tone="warn">
        Facebook needs your OK for Instagram messages before we can list your accounts.{' '}
        <a href={signIn} style={{ color: 'inherit', fontWeight: 700 }}>
          Continue with Facebook
        </a>
      </Notice>
    );
  }
  return (
    <div>
      {error && <Notice tone="error">{error}</Notice>}
      {accounts.length === 0 && !error && (
        <Notice tone="info">
          We could not find an Instagram account. It must be a professional (business or creator) account linked to a Facebook page you manage, and in the
          Instagram app, Settings → Messages and story replies → Message controls → Allow access to messages must be on.{' '}
          <a href={signIn} style={{ color: 'inherit', fontWeight: 700 }}>
            Allow Instagram again
          </a>
        </Notice>
      )}
      {accounts.map((a) => (
        <div key={a.id} className="page-row">
          <div>
            <strong>@{a.username}</strong>
            <span className="sub">Linked to {a.pageName}</span>
            {!a.canMessage && <span className="sub">You need permission to send messages as {a.pageName}.</span>}
            {a.connected === 'other_workspace' && <span className="sub">Connected to another shop on Agently.</span>}
          </div>
          {a.connected === 'this_workspace' ? (
            <Pill tone="green">Connected</Pill>
          ) : (
            <button type="button" className="btn primary sm" disabled={!a.canMessage || a.connected === 'other_workspace' || !!busy} onClick={() => connect(a)}>
              {busy === a.id ? 'Connecting…' : 'Connect'}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

declare global {
  interface Window {
    FB?: {
      init(o: Record<string, unknown>): void;
      login(cb: (r: { authResponse?: { code?: string } | null }) => void, o: Record<string, unknown>): void;
    };
    fbAsyncInit?: () => void;
  }
}

/** Loads Facebook's JavaScript SDK once, for WhatsApp Embedded Signup. */
function loadFacebookSdk(appId: string, version: string): Promise<NonNullable<Window['FB']>> {
  if (window.FB) return Promise.resolve(window.FB);
  return new Promise((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB!.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      resolve(window.FB!);
    };
    const s = document.createElement('script');
    s.src = 'https://connect.facebook.net/en_US/sdk.js';
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.onerror = () => reject(new Error('Could not load Facebook. Check your connection and try again.'));
    document.body.appendChild(s);
  });
}

/**
 * Connects a WhatsApp number: through Meta's Embedded Signup popup when the
 * app has it set up, or by pasting the number's details from Meta Business.
 */
export function WhatsAppConnect({ shopId, signup, onConnected }: { shopId: string; signup: ChannelUsage['whatsappSignup']; onConnected?: (name: string, hasAgent: boolean) => void }) {
  const api = useApi();
  const [manual, setManual] = useState(!signup);
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // The popup reports the chosen number and the code separately; both are needed.
  const session = useRef<{ phoneNumberId?: string; wabaId?: string; code?: string }>({});

  const finish = useCallback(
    async (path: string, body: Record<string, string>) => {
      setBusy(true);
      setError(undefined);
      try {
        const r = await api<{ channel: { name: string; hasAgent: boolean } }>(`/workspaces/${shopId}/whatsapp/${path}`, { method: 'POST', body });
        onConnected?.(r.channel.name, r.channel.hasAgent);
        setAccessToken('');
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [api, shopId, onConnected],
  );

  const trySignup = useCallback(() => {
    const s = session.current;
    if (s.code && s.phoneNumberId && s.wabaId) {
      session.current = {};
      void finish('signup', { code: s.code, phoneNumberId: s.phoneNumberId, wabaId: s.wabaId });
    }
  }, [finish]);

  useEffect(() => {
    if (!signup) return;
    const onMessage = (event: MessageEvent) => {
      if (!/(^|\.)facebook\.com$/.test(new URL(event.origin).hostname)) return;
      try {
        const data = JSON.parse(event.data as string) as { type?: string; event?: string; data?: { phone_number_id?: string; waba_id?: string } };
        if (data.type !== 'WA_EMBEDDED_SIGNUP') return;
        if (data.event === 'CANCEL') {
          setBusy(false);
          return;
        }
        if (data.data?.phone_number_id && data.data.waba_id) {
          session.current = { ...session.current, phoneNumberId: data.data.phone_number_id, wabaId: data.data.waba_id };
          trySignup();
        }
      } catch {
        // Other messages from Facebook's frames aren't JSON.
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [signup, trySignup]);

  async function startSignup() {
    if (!signup) return;
    setError(undefined);
    setBusy(true);
    try {
      const FB = await loadFacebookSdk(signup.appId, signup.version);
      FB.login(
        (r) => {
          const code = r.authResponse?.code;
          if (!code) {
            setBusy(false);
            return;
          }
          session.current = { ...session.current, code };
          trySignup();
        },
        { config_id: signup.configId, response_type: 'code', override_default_response_type: true, extras: { setup: {}, featureType: '', sessionInfoVersion: '3' } },
      );
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void finish('connect', { phoneNumberId: phoneNumberId.trim(), wabaId: wabaId.trim(), accessToken: accessToken.trim() });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {error && <Notice tone="error">{error}</Notice>}
      {signup && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" className="btn primary" disabled={busy} onClick={startSignup}>
            {busy && !manual ? 'Waiting for Facebook…' : 'Connect with Facebook'}
          </button>
          <span className="sub">Pick or add your WhatsApp Business number in the window that opens.</span>
        </div>
      )}
      {signup && !manual && (
        <button type="button" className="btn link" style={{ alignSelf: 'flex-start' }} onClick={() => setManual(true)}>
          I have the number&apos;s details from Meta
        </button>
      )}
      {manual && (
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p className="sub" style={{ margin: 0 }}>
            From Meta Business: WhatsApp Manager → your number, or the Meta app&apos;s WhatsApp → API Setup page. Use a permanent token (a system user token with
            whatsapp_business_messaging and whatsapp_business_management).
          </p>
          <div className="row">
            <label className="field">
              Phone number ID
              <input value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)} inputMode="numeric" pattern="\d{5,30}" required />
            </label>
            <label className="field">
              WhatsApp Business Account ID
              <input value={wabaId} onChange={(e) => setWabaId(e.target.value)} inputMode="numeric" pattern="\d{5,30}" required />
            </label>
          </div>
          <label className="field">
            Access token
            <input type="password" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} autoComplete="off" minLength={20} required />
            <small>Stored encrypted. Only used to send and receive this number&apos;s messages.</small>
          </label>
          <button type="submit" className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={busy}>
            {busy ? 'Connecting…' : 'Connect number'}
          </button>
        </form>
      )}
    </div>
  );
}
