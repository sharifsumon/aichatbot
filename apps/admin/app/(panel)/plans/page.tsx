'use client';

import { useState } from 'react';
import { useAdmin } from '@/components/Shell';
import { Dialog, Empty, Loading, Notice, Pill, TopBar } from '@/components/ui';
import { useApi, useLoad } from '@/lib/api';
import { bdt, num, usd } from '@/lib/format';
import type { Limits, Plan } from '@/lib/types';

const LIMIT_FIELDS: { key: keyof Limits; label: string }[] = [
  { key: 'aiCreditsPerMonth', label: 'AI credits a month' },
  { key: 'pages', label: 'Facebook pages' },
  { key: 'agents', label: 'Bots' },
  { key: 'staffSeats', label: 'Staff seats' },
  { key: 'knowledgeBaseMb', label: 'Knowledge base (MB)' },
];

export default function PlansPage() {
  const me = useAdmin();
  const { data, error, loading, reload } = useLoad<{ plans: Plan[] }>('/plans');
  const [editing, setEditing] = useState<Plan | 'new'>();
  const [done, setDone] = useState<string>();
  const canEdit = me.can('billing.manage');

  return (
    <>
      <TopBar title="Plans">
        {canEdit && (
          <button type="button" className="btn primary" onClick={() => setEditing('new')}>
            + New plan
          </button>
        )}
      </TopBar>
      <div className="content">
        <p className="muted" style={{ margin: 0 }}>
          Shops can&apos;t pay online yet, so finance moves a shop to a paid plan from its tenant page once the owner has paid. Changes to a plan apply to every shop on it; credit changes take effect from the next monthly grant.
        </p>
        {done && <Notice tone="ok">{done}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
        <div className="table-wrap">
          <table style={{ minWidth: 900 }}>
            <thead>
              <tr>
                <th>Plan</th>
                <th>Price</th>
                <th>AI credits</th>
                <th>Pages</th>
                <th>Staff</th>
                <th>Knowledge base</th>
                <th>Shops</th>
                <th>
                  <span className="sr">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data?.plans.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.name}</strong> {!p.active && <Pill>Hidden</Pill>}
                    <div className="sub">
                      <code>{p.key}</code>
                    </div>
                  </td>
                  <td>{p.trialDays ? `Free for ${p.trialDays} days` : `${bdt(p.priceBdt)} · ${usd(p.priceUsd, 0)} a month`}</td>
                  <td className="num">{num(p.limits.aiCreditsPerMonth)}</td>
                  <td className="num">{p.limits.pages}</td>
                  <td className="num">{p.limits.staffSeats}</td>
                  <td className="num">{num(p.limits.knowledgeBaseMb)} MB</td>
                  <td className="num">{num(p.tenants)}</td>
                  <td>
                    {canEdit && (
                      <button type="button" className="btn sm" onClick={() => setEditing(p)}>
                        Edit
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading && <Loading />}
          {data && data.plans.length === 0 && <Empty>No plans yet.</Empty>}
        </div>
      </div>
      {editing && (
        <PlanDialog
          plan={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(undefined)}
          onDone={(m) => {
            setEditing(undefined);
            setDone(m);
            reload();
          }}
        />
      )}
    </>
  );
}

function PlanDialog({ plan, onClose, onDone }: { plan?: Plan; onClose: () => void; onDone: (m: string) => void }) {
  const api = useApi();
  const [key, setKey] = useState('');
  const [name, setName] = useState(plan?.name ?? '');
  const [priceBdt, setPriceBdt] = useState(plan ? String(Number(plan.priceBdt)) : '');
  const [priceUsd, setPriceUsd] = useState(plan ? String(Number(plan.priceUsd)) : '');
  const [active, setActive] = useState(plan?.active ?? true);
  const [limits, setLimits] = useState<Record<keyof Limits, string>>({
    aiCreditsPerMonth: String(plan?.limits.aiCreditsPerMonth ?? 2000),
    pages: String(plan?.limits.pages ?? 1),
    agents: String(plan?.limits.agents ?? 1),
    staffSeats: String(plan?.limits.staffSeats ?? 2),
    knowledgeBaseMb: String(plan?.limits.knowledgeBaseMb ?? 50),
  });

  return (
    <Dialog
      title={plan ? `Edit ${plan.name}` : 'New plan'}
      submitLabel={plan ? 'Save plan' : 'Create plan'}
      wide
      onClose={onClose}
      onSubmit={async () => {
        const l = Object.fromEntries(Object.entries(limits).map(([k, v]) => [k, Number.parseInt(v, 10)])) as unknown as Limits;
        if (Object.values(l).some((v) => !Number.isFinite(v) || v < 0)) return 'Limits must be whole numbers.';
        const body = { name: name.trim(), priceBdt: priceBdt.trim(), priceUsd: priceUsd.trim(), limits: l };
        if (plan) {
          await api(`/plans/${plan.id}`, { method: 'PATCH', body: { ...body, active } });
          onDone(`${body.name} is saved.`);
        } else {
          await api('/plans', { method: 'POST', body: { ...body, key: key.trim() } });
          onDone(`${body.name} is created.`);
        }
      }}
    >
      <div className="row">
        <label className="field">
          Name
          <input required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {!plan && (
          <label className="field">
            Key
            <input required pattern="[a-z0-9-]{2,40}" placeholder="e.g. growth" value={key} onChange={(e) => setKey(e.target.value)} />
            <small>Lowercase letters, digits and dashes. Can&apos;t change later.</small>
          </label>
        )}
      </div>
      {!plan?.trialDays && (
        <div className="row">
          <label className="field">
            Price a month (৳)
            <input required inputMode="decimal" value={priceBdt} onChange={(e) => setPriceBdt(e.target.value)} />
          </label>
          <label className="field">
            Price a month ($)
            <input required inputMode="decimal" value={priceUsd} onChange={(e) => setPriceUsd(e.target.value)} />
          </label>
        </div>
      )}
      <div className="row">
        {LIMIT_FIELDS.map((f) => (
          <label key={f.key} className="field">
            {f.label}
            <input type="number" min={0} required value={limits[f.key]} onChange={(e) => setLimits((l) => ({ ...l, [f.key]: e.target.value }))} />
          </label>
        ))}
      </div>
      {plan && (
        <label className="check">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Offered to new shops
        </label>
      )}
    </Dialog>
  );
}
