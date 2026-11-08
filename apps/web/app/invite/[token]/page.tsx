'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/icons';
import { rememberShop } from '@/components/Shell';
import { Loading, Notice } from '@/components/ui';
import { ApiError, useApi, useApiBase } from '@/lib/api';
import { INVITE_KEY, save } from '@/lib/storage';

interface Invite {
  workspace: { id: string; name: string };
  role: 'admin' | 'agent';
  invitedBy: string | null;
  state: 'pending' | 'accepted' | 'revoked' | 'expired';
  alreadyMember: boolean;
}

const GONE = { accepted: 'has already been used', revoked: 'was cancelled', expired: 'has expired' } as const;

/** "Join <shop> as <role>". Signed-out visitors sign in with Facebook first and come back here. */
export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const api = useApi();
  const base = useApiBase();
  const [invite, setInvite] = useState<Invite>();
  const [signedOut, setSignedOut] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ invite: Invite }>(`/invites/${token}`)
      .then((r) => setInvite(r.invite))
      .catch((e: ApiError) => {
        if (e.status === 401) {
          save(INVITE_KEY, token);
          setSignedOut(true);
        } else setError(e.message);
      });
  }, [api, token]);

  async function accept() {
    setBusy(true);
    setError(undefined);
    try {
      const r = await api<{ workspace: { id: string } }>(`/invites/${token}/accept`, { method: 'POST' });
      rememberShop(r.workspace.id);
      window.location.href = '/dashboard';
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <div className="card">
        <div className="brand" style={{ padding: 0 }}>
          <Icon.logo />
          Agently
        </div>
        {signedOut ? (
          <>
            <h1>You&apos;ve been invited to a shop on Agently</h1>
            <p className="muted" style={{ margin: 0 }}>
              Sign in with Facebook to see the invite and join the team.
            </p>
            <a className="btn fb" href={`${base}/auth/facebook`}>
              Continue with Facebook
            </a>
          </>
        ) : error ? (
          <Notice tone="error">{error}</Notice>
        ) : !invite ? (
          <Loading />
        ) : invite.alreadyMember ? (
          <>
            <h1>You&apos;re already on the {invite.workspace.name} team</h1>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                rememberShop(invite.workspace.id);
                window.location.href = '/dashboard';
              }}
            >
              Open the dashboard
            </button>
          </>
        ) : invite.state !== 'pending' ? (
          <>
            <h1>This invite {GONE[invite.state]}</h1>
            <p className="muted" style={{ margin: 0 }}>
              Ask {invite.invitedBy ?? 'the shop'} for a new link.
            </p>
          </>
        ) : (
          <>
            <h1>Join {invite.workspace.name}</h1>
            <p className="muted" style={{ margin: 0 }}>
              {invite.invitedBy ?? 'The shop'} invited you as {invite.role === 'admin' ? 'an admin. You can answer chats, manage orders and change the shop’s settings.' : 'an agent. You can answer chats and manage orders.'}
            </p>
            <button type="button" className="btn primary" onClick={accept} disabled={busy}>
              {busy ? 'Joining…' : 'Join the team'}
            </button>
          </>
        )}
      </div>
    </main>
  );
}
