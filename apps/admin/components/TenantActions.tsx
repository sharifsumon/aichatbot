'use client';

import { useState } from 'react';
import { useApi, useLoad } from '@/lib/api';
import { bdt, date } from '@/lib/format';
import type { Plan, TenantStatus } from '@/lib/types';
import { useAdmin } from './Shell';
import { Dialog } from './ui';

export type TenantAction = 'credits' | 'trial' | 'suspend' | 'reactivate' | 'plan';

interface Target {
  id: string;
  name: string;
  status: TenantStatus;
  trialEndsAt: string | null;
  planKey?: string | null;
}

/** Which actions this admin may take on a shop in this state. */
export function useTenantActions() {
  const me = useAdmin();
  return (t: Pick<Target, 'status'>): TenantAction[] => {
    const out: TenantAction[] = [];
    if (me.can('billing.manage')) out.push('credits', 'plan');
    if (me.can('tenants.manage')) {
      if (t.status === 'trial') out.push('trial');
      out.push(t.status === 'suspended' ? 'reactivate' : 'suspend');
    }
    return out;
  };
}

export const ACTION_LABEL: Record<TenantAction, string> = {
  credits: 'Add credits',
  trial: 'Extend trial',
  suspend: 'Suspend',
  reactivate: 'Reactivate',
  plan: 'Change plan',
};

/** The dialog for one action. Every change is written to the audit log by the API. */
export function TenantActionDialog({ action, tenant, onClose, onDone }: { action: TenantAction; tenant: Target; onClose: () => void; onDone: (message: string) => void }) {
  const api = useApi();
  const [credits, setCredits] = useState('500');
  const [note, setNote] = useState('');
  const [days, setDays] = useState('7');
  const [reason, setReason] = useState('');
  const [planKey, setPlanKey] = useState(tenant.planKey ?? '');
  const plans = useLoad<{ plans: Plan[] }>(action === 'plan' ? '/plans' : null);
  const path = `/tenants/${tenant.id}`;

  if (action === 'credits')
    return (
      <Dialog
        title={`Add AI credits to ${tenant.name}`}
        submitLabel="Add credits"
        onClose={onClose}
        onSubmit={async () => {
          const n = Number.parseInt(credits, 10);
          if (!Number.isFinite(n) || n === 0) return 'Enter a number of credits (use a minus sign to take credits back).';
          if (note.trim().length < 3) return 'Add a short note for the audit log.';
          await api(`${path}/credits`, { method: 'POST', body: { credits: n, note: note.trim() } });
          onDone(n > 0 ? `Added ${n.toLocaleString('en')} credits to ${tenant.name}.` : `Took back ${Math.abs(n).toLocaleString('en')} credits from ${tenant.name}.`);
        }}
      >
        <label className="field">
          Credits
          <input type="number" inputMode="numeric" min={-100000} max={100000} step={1} required value={credits} onChange={(e) => setCredits(e.target.value)} />
          <small>One credit is one AI reply. They last until the end of this month. A negative number takes credits back.</small>
        </label>
        <label className="field">
          Note for the audit log
          <input required minLength={3} maxLength={300} placeholder="e.g. Sorry for the outage on 3 Nov" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      </Dialog>
    );

  if (action === 'trial')
    return (
      <Dialog
        title={`Extend ${tenant.name}'s trial`}
        submitLabel="Extend trial"
        onClose={onClose}
        onSubmit={async () => {
          const n = Number.parseInt(days, 10);
          if (!(n >= 1 && n <= 90)) return 'Choose between 1 and 90 days.';
          const r = await api<{ trialEndsAt: string }>(`${path}/extend-trial`, { method: 'POST', body: { days: n } });
          onDone(`${tenant.name}'s trial now ends on ${date(r.trialEndsAt)}.`);
        }}
      >
        <p className="muted" style={{ margin: 0 }}>
          {tenant.trialEndsAt ? `The trial ends on ${date(tenant.trialEndsAt)}.` : 'This shop has no trial end date.'} The trial credits last until the new end date.
        </p>
        <label className="field">
          Extra days
          <input type="number" min={1} max={90} required value={days} onChange={(e) => setDays(e.target.value)} />
        </label>
      </Dialog>
    );

  if (action === 'suspend')
    return (
      <Dialog
        title={`Suspend ${tenant.name}?`}
        submitLabel="Suspend shop"
        danger
        onClose={onClose}
        onSubmit={async () => {
          if (reason.trim().length < 3) return 'Write the reason. The owner sees it.';
          await api(`${path}/suspend`, { method: 'POST', body: { reason: reason.trim() } });
          onDone(`${tenant.name} is suspended. The bot has stopped replying.`);
        }}
      >
        <p className="muted" style={{ margin: 0 }}>
          The bot stops replying at once. Messages still arrive, and the owner sees the reason below in their dashboard.
        </p>
        <label className="field">
          Reason (shown to the owner)
          <textarea rows={3} required minLength={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
      </Dialog>
    );

  if (action === 'reactivate')
    return (
      <Dialog
        title={`Reactivate ${tenant.name}?`}
        submitLabel="Reactivate"
        onClose={onClose}
        onSubmit={async () => {
          const r = await api<{ status: TenantStatus }>(`${path}/reactivate`, { method: 'POST' });
          onDone(`${tenant.name} is back on ${r.status === 'trial' ? 'its trial' : 'its plan'}, and the bot replies again.`);
        }}
      >
        <p className="muted" style={{ margin: 0 }}>
          The bot starts replying again. The shop goes back to its trial if the trial hasn&apos;t ended, otherwise to its plan.
        </p>
      </Dialog>
    );

  // Change plan
  const options = (plans.data?.plans ?? []).filter((p) => p.active || p.key === tenant.planKey);
  return (
    <Dialog
      title={`Change ${tenant.name}'s plan`}
      submitLabel="Change plan"
      onClose={onClose}
      onSubmit={async () => {
        if (!planKey) return 'Choose a plan.';
        const r = await api<{ plan: { name: string }; creditsAdded: number }>(`${path}/plan`, { method: 'POST', body: { planKey } });
        onDone(`${tenant.name} is now on ${r.plan.name}.${r.creditsAdded ? ` ${r.creditsAdded.toLocaleString('en')} credits added for this month.` : ''}`);
      }}
    >
      <p className="muted" style={{ margin: 0 }}>
        Until shops can pay online, use this after the owner has paid. A paid plan makes the shop active and tops up this month&apos;s credits to the plan&apos;s allowance.
      </p>
      <label className="field">
        Plan
        <select required value={planKey} onChange={(e) => setPlanKey(e.target.value)} disabled={plans.loading}>
          <option value="">{plans.loading ? 'Loading plans…' : 'Choose a plan'}</option>
          {options.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name} · {p.trialDays ? `${p.trialDays}-day trial` : `${bdt(p.priceBdt)}/month`} · {p.limits.aiCreditsPerMonth.toLocaleString('en')} credits
            </option>
          ))}
        </select>
      </label>
    </Dialog>
  );
}
