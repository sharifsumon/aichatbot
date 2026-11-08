'use client';

import { useState } from 'react';
import { useAdmin } from '@/components/Shell';
import { Dialog, Empty, Loading, Notice, Pill, TopBar } from '@/components/ui';
import { useApi, useLoad } from '@/lib/api';
import { ago } from '@/lib/format';
import { ROLE_LABEL, type PlatformRole, type TeamMember } from '@/lib/types';

const ROLE_HELP: Record<PlatformRole, string> = {
  super_admin: 'Everything, including the team, settings and audit log',
  support: 'Shops and chats; no billing',
  finance: 'Shops, plans and credits; no chats',
};

type Pending = { kind: 'add' } | { kind: 'role'; member: TeamMember } | { kind: 'disable'; member: TeamMember } | { kind: 'reset'; member: TeamMember };

export default function TeamPage() {
  const me = useAdmin();
  const api = useApi();
  const { data, error, loading, reload } = useLoad<{ team: TeamMember[] }>('/team');
  const [pending, setPending] = useState<Pending>();
  const [done, setDone] = useState<string>();
  const [password, setPassword] = useState<{ email: string; password: string }>();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<PlatformRole>('support');

  const finish = (m: string) => {
    setPending(undefined);
    setDone(m);
    reload();
  };

  async function enable(m: TeamMember) {
    try {
      await api(`/team/${m.id}`, { method: 'PATCH', body: { disabled: false } });
      finish(`${m.name} can sign in again.`);
    } catch (e) {
      setDone(undefined);
      alert((e as Error).message);
    }
  }

  return (
    <>
      <TopBar title="Team and roles">
        <button
          type="button"
          className="btn primary"
          onClick={() => {
            setName('');
            setEmail('');
            setRole('support');
            setPending({ kind: 'add' });
          }}
        >
          + Add team member
        </button>
      </TopBar>
      <div className="content">
        {password && (
          <Notice tone="warn">
            <strong>One-time password for {password.email}:</strong> <code style={{ fontSize: 14 }}>{password.password}</code>
            <br />
            Give it to them privately. It is shown only once; they set up two-step sign-in the first time they sign in.{' '}
            <button type="button" className="btn link" onClick={() => setPassword(undefined)}>
              Hide
            </button>
          </Notice>
        )}
        {done && <Notice tone="ok">{done}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
        <div className="table-wrap">
          <table style={{ minWidth: 820 }}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Two-step sign-in</th>
                <th>Last sign-in</th>
                <th>
                  <span className="sr">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data?.team.map((m) => (
                <tr key={m.id}>
                  <td>
                    <strong>{m.name}</strong> {m.id === me.id && <Pill tone="brand">You</Pill>} {m.disabledAt && <Pill tone="red">Disabled</Pill>}
                    <div className="sub">{m.email}</div>
                  </td>
                  <td>
                    {ROLE_LABEL[m.role]}
                    <div className="sub">{ROLE_HELP[m.role]}</div>
                  </td>
                  <td>{m.twoFactor ? <Pill tone="green">On</Pill> : <Pill tone="amber">Not set up yet</Pill>}</td>
                  <td className="muted">{ago(m.lastLoginAt)}</td>
                  <td>
                    <div className="actions">
                      <button type="button" className="btn sm" onClick={() => (setRole(m.role), setPending({ kind: 'role', member: m }))}>
                        Change role
                      </button>
                      {m.twoFactor && (
                        <button type="button" className="btn sm" onClick={() => setPending({ kind: 'reset', member: m })}>
                          Reset 2FA
                        </button>
                      )}
                      {m.id !== me.id &&
                        (m.disabledAt ? (
                          <button type="button" className="btn sm" onClick={() => enable(m)}>
                            Enable
                          </button>
                        ) : (
                          <button type="button" className="btn sm" onClick={() => setPending({ kind: 'disable', member: m })}>
                            Disable
                          </button>
                        ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading && <Loading />}
          {data && data.team.length === 0 && <Empty>No team members.</Empty>}
        </div>
      </div>

      {pending?.kind === 'add' && (
        <Dialog
          title="Add a team member"
          submitLabel="Add"
          onClose={() => setPending(undefined)}
          onSubmit={async () => {
            const r = await api<{ member: TeamMember; temporaryPassword: string }>('/team', { method: 'POST', body: { name: name.trim(), email: email.trim(), role } });
            setPassword({ email: r.member.email, password: r.temporaryPassword });
            finish(`${r.member.name} is added as ${ROLE_LABEL[r.member.role]}.`);
          }}
        >
          <label className="field">
            Name
            <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            Email
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <RolePicker value={role} onChange={setRole} />
        </Dialog>
      )}
      {pending?.kind === 'role' && (
        <Dialog
          title={`Change ${pending.member.name}'s role`}
          submitLabel="Save role"
          onClose={() => setPending(undefined)}
          onSubmit={async () => {
            await api(`/team/${pending.member.id}`, { method: 'PATCH', body: { role } });
            finish(`${pending.member.name} is now ${ROLE_LABEL[role]}. They need to sign in again.`);
          }}
        >
          <RolePicker value={role} onChange={setRole} />
        </Dialog>
      )}
      {pending?.kind === 'disable' && (
        <Dialog
          title={`Disable ${pending.member.name}?`}
          submitLabel="Disable"
          danger
          onClose={() => setPending(undefined)}
          onSubmit={async () => {
            await api(`/team/${pending.member.id}`, { method: 'PATCH', body: { disabled: true } });
            finish(`${pending.member.name} is disabled and signed out.`);
          }}
        >
          <p style={{ margin: 0 }}>They are signed out at once and can&apos;t sign in until you enable them again. Their audit log entries stay.</p>
        </Dialog>
      )}
      {pending?.kind === 'reset' && (
        <Dialog
          title={`Reset ${pending.member.name}'s two-step sign-in?`}
          submitLabel="Reset"
          danger
          onClose={() => setPending(undefined)}
          onSubmit={async () => {
            await api(`/team/${pending.member.id}`, { method: 'PATCH', body: { resetTwoFactor: true } });
            finish(`${pending.member.name} sets up two-step sign-in again next time they sign in.`);
          }}
        >
          <p style={{ margin: 0 }}>Use this when they lose their phone. They are signed out and set up a new authenticator app at their next sign-in.</p>
        </Dialog>
      )}
    </>
  );
}

function RolePicker({ value, onChange }: { value: PlatformRole; onChange: (r: PlatformRole) => void }) {
  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <legend className="field" style={{ marginBottom: 6 }}>
        Role
      </legend>
      {(Object.keys(ROLE_LABEL) as PlatformRole[]).map((r) => (
        <label key={r} className="check" style={{ alignItems: 'flex-start' }}>
          <input type="radio" name="role" value={r} checked={value === r} onChange={() => onChange(r)} />
          <span>
            <strong>{ROLE_LABEL[r]}</strong>
            <span className="sub" style={{ display: 'block' }}>
              {ROLE_HELP[r]}
            </span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
