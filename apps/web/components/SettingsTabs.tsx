'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { PagePicker } from '@/components/PagePicker';
import { useShop } from '@/components/Shell';
import { DayChart, Dialog, Empty, Loading, Meter, Notice, Pill, ShopStatusPill, Toggle } from '@/components/ui';
import { useApi, useLoad } from '@/lib/api';
import { bdt, date, daysLeft, num, usd } from '@/lib/format';
import type { Billing, Channel, Role, Settings, Team } from '@/lib/types';

function useSettings() {
  const { ws, reloadHome, reloadMe } = useShop();
  const api = useApi();
  const load = useLoad<{ settings: Settings }>(`${ws}/settings`);
  const [saved, setSaved] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function save(body: Partial<Record<keyof Settings, unknown>>, message = 'Saved.') {
    setBusy(true);
    setSaved(undefined);
    setError(undefined);
    try {
      await api(`${ws}/settings`, { method: 'PATCH', body });
      setSaved(message);
      load.reload();
      reloadHome();
      if ('name' in body) reloadMe();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return { settings: load.data?.settings, loadError: load.error, saved, error, busy, save };
}

function Status({ saved, error }: { saved?: string; error?: string }) {
  return (
    <>
      {saved && <Notice tone="ok">{saved}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
    </>
  );
}

function Section({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="card pad">
      <div>
        <h2>{title}</h2>
        {note && (
          <p className="sub" style={{ margin: '4px 0 0', fontSize: 13 }}>
            {note}
          </p>
        )}
      </div>
      {children}
    </section>
  );
}

export function ShopTab() {
  const { settings, loadError, saved, error, busy, save } = useSettings();
  const [name, setName] = useState('');
  const [locale, setLocale] = useState<Settings['locale']>('bn');
  const [businessType, setBusinessType] = useState<Settings['businessType']>('ecommerce');

  useEffect(() => {
    if (!settings) return;
    setName(settings.name);
    setLocale(settings.locale);
    setBusinessType(settings.businessType);
  }, [settings]);

  if (!settings) return loadError ? <Notice tone="error">{loadError}</Notice> : <Loading />;
  return (
    <form
      style={{ display: 'flex', flexDirection: 'column', gap: 20 }}
      onSubmit={(e) => {
        e.preventDefault();
        save({ name, locale, businessType });
      }}
    >
      <Status saved={saved} error={error} />
      <Section title="Shop profile">
        <label className="field">
          Shop name
          <input value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={80} required />
        </label>
        <div className="row">
          <label className="field">
            Language the bot starts in
            <select value={locale} onChange={(e) => setLocale(e.target.value as Settings['locale'])}>
              <option value="bn">Bangla</option>
              <option value="en">English</option>
            </select>
            <small>After that it follows the customer.</small>
          </label>
          <label className="field">
            What you sell
            <select value={businessType} onChange={(e) => setBusinessType(e.target.value as Settings['businessType'])}>
              <option value="ecommerce">Products (online shop)</option>
              <option value="services">Services</option>
              <option value="other">Something else</option>
            </select>
          </label>
        </div>
      </Section>
      <div className="save-bar">
        <a href="/start" className="btn link" style={{ marginRight: 'auto' }}>
          Add another shop
        </a>
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}

export function PaymentsTab() {
  const { settings, loadError, saved, error, busy, save } = useSettings();
  const [cod, setCod] = useState(true);
  const [bkashOn, setBkashOn] = useState(false);
  const [bkash, setBkash] = useState('');
  const [nagadOn, setNagadOn] = useState(false);
  const [nagad, setNagad] = useState('');
  const [inside, setInside] = useState('');
  const [outside, setOutside] = useState('');

  useEffect(() => {
    if (!settings) return;
    setCod(settings.codEnabled);
    setBkashOn(!!settings.bkashNumber);
    setBkash(settings.bkashNumber ?? '');
    setNagadOn(!!settings.nagadNumber);
    setNagad(settings.nagadNumber ?? '');
    setInside(String(Number(settings.deliveryChargeInsideDhaka)));
    setOutside(String(Number(settings.deliveryChargeOutsideDhaka)));
  }, [settings]);

  if (!settings) return loadError ? <Notice tone="error">{loadError}</Notice> : <Loading />;

  function submit(e: FormEvent) {
    e.preventDefault();
    save(
      {
        codEnabled: cod,
        bkashNumber: bkashOn ? bkash : null,
        nagadNumber: nagadOn ? nagad : null,
        deliveryChargeInsideDhaka: inside,
        deliveryChargeOutsideDhaka: outside,
      },
      'Saved. The bot uses these from its next reply.',
    );
  }

  return (
    <form style={{ display: 'flex', flexDirection: 'column', gap: 20 }} onSubmit={submit}>
      <Status saved={saved} error={error} />
      <Section title="Payment methods" note="The bot offers only what is switched on. For bKash and Nagad it sends your number and the amount, then asks the customer for the transaction ID.">
        <div className="option">
          <div>
            <strong>Cash on delivery</strong>
            <span>Courier collects the full total, delivery charge included.</span>
          </div>
          <Toggle checked={cod} onChange={setCod} label={cod ? 'On' : 'Off'} />
        </div>
        <div className="option">
          <div>
            <strong>bKash</strong>
            <span>Customers send money to this number.</span>
          </div>
          <Toggle checked={bkashOn} onChange={setBkashOn} label={bkashOn ? 'On' : 'Off'} />
          {bkashOn && (
            <label className="field" style={{ flexBasis: '100%' }}>
              bKash number
              <input value={bkash} onChange={(e) => setBkash(e.target.value)} placeholder="01XXXXXXXXX" inputMode="tel" required />
            </label>
          )}
        </div>
        <div className="option">
          <div>
            <strong>Nagad</strong>
            <span>Customers send money to this number.</span>
          </div>
          <Toggle checked={nagadOn} onChange={setNagadOn} label={nagadOn ? 'On' : 'Off'} />
          {nagadOn && (
            <label className="field" style={{ flexBasis: '100%' }}>
              Nagad number
              <input value={nagad} onChange={(e) => setNagad(e.target.value)} placeholder="01XXXXXXXXX" inputMode="tel" required />
            </label>
          )}
        </div>
      </Section>
      <Section title="Delivery charges" note="Added to every order total.">
        <div className="row">
          <label className="field">
            Inside Dhaka (৳)
            <input value={inside} onChange={(e) => setInside(e.target.value)} inputMode="decimal" required />
          </label>
          <label className="field">
            Outside Dhaka (৳)
            <input value={outside} onChange={(e) => setOutside(e.target.value)} inputMode="decimal" required />
          </label>
        </div>
      </Section>
      <div className="save-bar">
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}

const CHANNEL_STATUS: Record<Channel['status'], { label: string; tone: 'green' | 'amber' | 'red' }> = {
  connected: { label: 'Connected', tone: 'green' },
  token_expired: { label: 'Needs reconnecting', tone: 'amber' },
  error: { label: 'Error', tone: 'red' },
  disconnected: { label: 'Disconnected', tone: 'red' },
};

export function PagesTab() {
  const { ws, shop, reloadHome } = useShop();
  const api = useApi();
  const { data, error, reload } = useLoad<{ channels: Channel[] }>(`${ws}/channels`);
  const [done, setDone] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [adding, setAdding] = useState(false);

  async function disconnect(c: Channel) {
    if (!window.confirm(`Disconnect ${c.name}? The bot stops replying there until you connect it again.`)) return;
    try {
      await api(`${ws}/channels/${c.id}/disconnect`, { method: 'POST' });
      setDone(`${c.name} disconnected.`);
      reload();
      reloadHome();
    } catch (e) {
      setProblem((e as Error).message);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Status saved={done} error={problem ?? error} />
      <Section title="Connected pages" note="The bot answers messages and comments on these pages.">
        {!data ? (
          <Loading />
        ) : data.channels.length === 0 ? (
          <Empty>No page connected yet.</Empty>
        ) : (
          data.channels.map((c) => (
            <div key={c.id} className="page-row">
              <div>
                <strong>{c.name}</strong>
                <span className="sub">{c.type === 'facebook_page' ? 'Facebook page' : c.type}</span>
                {c.lastError && c.status !== 'connected' && <span className="sub" style={{ color: 'var(--red)' }}>{c.lastError}</span>}
              </div>
              <Pill tone={CHANNEL_STATUS[c.status].tone}>{CHANNEL_STATUS[c.status].label}</Pill>
              <button type="button" className="btn sm" onClick={() => disconnect(c)}>
                Disconnect
              </button>
            </div>
          ))
        )}
        {!adding && (
          <button type="button" className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => setAdding(true)}>
            {data?.channels.some((c) => c.status !== 'connected') ? 'Reconnect or add a page' : 'Connect a page'}
          </button>
        )}
      </Section>
      {adding && (
        <Section title="Your Facebook pages" note="Pick the page to connect. Reconnecting a page that needs it fixes the connection.">
          <PagePicker
            shopId={shop.id}
            onConnected={(name) => {
              setDone(`${name} connected.`);
              reload();
              reloadHome();
            }}
          />
        </Section>
      )}
    </div>
  );
}

const ROLE: Record<Role, string> = { owner: 'Owner', admin: 'Admin', agent: 'Agent' };

export function TeamTab() {
  const { ws, shop, me } = useShop();
  const api = useApi();
  const { data, error, reload } = useLoad<Team>(`${ws}/members`);
  const [inviting, setInviting] = useState(false);
  const [link, setLink] = useState<string>();
  const [done, setDone] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [transfer, setTransfer] = useState<Team['members'][number]>();
  const owner = shop.role === 'owner';

  async function run(path: string, init: { method: string; body?: unknown }, message: string) {
    setProblem(undefined);
    try {
      await api(path, init);
      setDone(message);
      reload();
    } catch (e) {
      setProblem((e as Error).message);
    }
  }

  if (!data) return error ? <Notice tone="error">{error}</Notice> : <Loading />;
  const full = data.seats.used >= data.seats.limit;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Status saved={done} error={problem} />
      {link && (
        <Notice tone="info">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <strong>Send this link to the person you invited. It works once, for 7 days.</strong>
            <code className="secret" style={{ color: 'var(--ink)' }}>
              {link}
            </code>
            <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => navigator.clipboard?.writeText(link).then(() => setDone('Link copied.'))}>
              Copy link
            </button>
          </div>
        </Notice>
      )}
      <Section
        title="Team"
        note={
          <>
            Agents can answer chats and manage orders. Admins can also change settings, products and the bot. {num(data.seats.used)} of {num(data.seats.limit)} seats used.
          </>
        }
      >
        {data.members.map((m) => (
          <div key={m.userId} className="page-row">
            <div>
              <strong>
                {m.name ?? 'No name'}
                {m.userId === me.user.id ? ' (you)' : ''}
              </strong>
              <span className="sub">{m.email ?? 'Signed in with Facebook'}</span>
            </div>
            {owner && m.role !== 'owner' ? (
              <select className="input" aria-label={`Role for ${m.name}`} value={m.role} onChange={(e) => run(`${ws}/members/${m.userId}`, { method: 'PATCH', body: { role: e.target.value } }, `${m.name} is now ${ROLE[e.target.value as Role].toLowerCase()}.`)}>
                <option value="admin">Admin</option>
                <option value="agent">Agent</option>
              </select>
            ) : (
              <Pill tone={m.role === 'owner' ? 'brand' : undefined}>{ROLE[m.role]}</Pill>
            )}
            {owner && m.role !== 'owner' && (
              <button type="button" className="btn sm" onClick={() => setTransfer(m)}>
                Make owner
              </button>
            )}
            {m.role !== 'owner' && (owner || (shop.role === 'admin' && m.role === 'agent') || m.userId === me.user.id) && (
              <button
                type="button"
                className="btn sm"
                onClick={() =>
                  window.confirm(m.userId === me.user.id ? 'Leave this shop?' : `Remove ${m.name} from the team?`) &&
                  run(`${ws}/members/${m.userId}`, { method: 'DELETE' }, m.userId === me.user.id ? 'You left the shop.' : `${m.name} removed.`).then(() => {
                    if (m.userId === me.user.id) window.location.href = '/';
                  })
                }
              >
                {m.userId === me.user.id ? 'Leave' : 'Remove'}
              </button>
            )}
          </div>
        ))}
        {data.invites.map((i) => (
          <div key={i.id} className="page-row">
            <div>
              <strong>{i.email ?? 'Invite link'}</strong>
              <span className="sub">Invited as {ROLE[i.role].toLowerCase()} · expires {date(i.expiresAt)}</span>
            </div>
            <Pill tone="amber">Waiting</Pill>
            <button type="button" className="btn sm" onClick={() => run(`${ws}/invites/${i.id}`, { method: 'DELETE' }, 'Invite cancelled.')}>
              Cancel invite
            </button>
          </div>
        ))}
        {full ? (
          <Notice tone="warn">All your seats are taken. Remove someone or upgrade your plan to invite more people.</Notice>
        ) : (
          <button type="button" className="btn primary" style={{ alignSelf: 'flex-start' }} onClick={() => setInviting(true)}>
            + Invite someone
          </button>
        )}
      </Section>
      {inviting && (
        <InviteDialog
          canInviteAdmin={owner}
          onClose={() => setInviting(false)}
          onDone={(url) => {
            setInviting(false);
            setLink(url);
            reload();
          }}
        />
      )}
      {transfer && (
        <Dialog
          title={`Make ${transfer.name} the owner?`}
          submitLabel="Make owner"
          danger
          onClose={() => setTransfer(undefined)}
          onSubmit={async () => {
            await api(`${ws}/transfer-ownership`, { method: 'POST', body: { userId: transfer.userId } });
            window.location.href = '/settings?tab=team';
          }}
        >
          <p className="muted" style={{ margin: 0 }}>
            They get full control of the shop, including billing and the team. You become an admin. Only they can give ownership back.
          </p>
        </Dialog>
      )}
    </div>
  );
}

function InviteDialog({ canInviteAdmin, onClose, onDone }: { canInviteAdmin: boolean; onClose: () => void; onDone: (url: string) => void }) {
  const { ws } = useShop();
  const api = useApi();
  const [role, setRole] = useState<'agent' | 'admin'>('agent');
  const [email, setEmail] = useState('');
  return (
    <Dialog
      title="Invite someone to your team"
      submitLabel="Create invite link"
      onClose={onClose}
      onSubmit={async () => {
        const r = await api<{ url: string }>(`${ws}/invites`, { method: 'POST', body: { role, email: email.trim() || null } });
        onDone(r.url);
      }}
    >
      <label className="field">
        Role
        <select value={role} onChange={(e) => setRole(e.target.value as 'agent' | 'admin')}>
          <option value="agent">Agent: answers chats and manages orders</option>
          {canInviteAdmin && <option value="admin">Admin: also changes settings, products and the bot</option>}
        </select>
      </label>
      <label className="field">
        Their email <small>(optional, for your own records)</small>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <p className="sub" style={{ margin: 0 }}>
        You get a link to send them on WhatsApp or Messenger. They sign in with Facebook to join.
      </p>
    </Dialog>
  );
}

export function BillingTab() {
  const { ws } = useShop();
  const { data: b, error } = useLoad<Billing>(`${ws}/billing`);
  const usage = useLoad<{ days: { day: string; aiReplies: number }[] }>(`${ws}/usage?days=30`);

  if (!b) return error ? <Notice tone="error">{error}</Notice> : <Loading />;
  const price = (p: { priceBdt: string; priceUsd: string }) => (b.currency === 'BDT' ? bdt(p.priceBdt) : usd(p.priceUsd, 0));
  const kb = b.usage.knowledgeBase;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Section title="Your plan">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 20 }}>{b.plan?.name ?? 'No plan'}</strong>
          <ShopStatusPill status={b.status} trialDaysLeft={daysLeft(b.trialEndsAt)} />
          {b.plan && Number(b.plan.priceBdt) > 0 && <span className="muted">{price(b.plan)} a month</span>}
        </div>
        {b.status === 'trial' && b.trialEndsAt && (
          <span className="muted">
            {b.trialEnded ? 'Your free trial has ended.' : `Your free trial ends on ${date(b.trialEndsAt)}.`} Choose a plan below to keep the bot replying.
          </span>
        )}
        <Meter used={b.credits.used} total={b.credits.granted} label={`AI replies this month: ${num(b.credits.used)} of ${num(b.credits.granted)}`} />
        <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
          <Meter used={b.usage.pages.used} total={b.usage.pages.limit} label={`Facebook pages: ${b.usage.pages.used} of ${b.usage.pages.limit}`} />
          <Meter used={b.usage.staffSeats.used} total={b.usage.staffSeats.limit} label={`Team seats: ${b.usage.staffSeats.used} of ${b.usage.staffSeats.limit}`} />
          <Meter used={kb.usedBytes} total={kb.limitBytes} label={`Knowledge base: ${(kb.usedBytes / 1048576).toFixed(1)} of ${Math.round(kb.limitBytes / 1048576)} MB`} />
        </div>
      </Section>
      <Section title="AI replies, last 30 days">
        {usage.data ? <DayChart days={usage.data.days.filter((d) => d.aiReplies > 0)} value={(d) => d.aiReplies} label="AI replies" span={30} /> : <Loading />}
      </Section>
      <Section
        title="Plans"
        note={
          b.paymentsAvailable
            ? undefined
            : 'Online payment is coming soon. To upgrade or buy extra replies now, message Agently on our Facebook page and we will switch your plan.'
        }
      >
        <div className="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
          {b.plans.map((p) => (
            <div key={p.key} className="card pad" style={p.current ? { borderColor: 'var(--brand)', boxShadow: '0 0 0 3px var(--brand-soft)' } : undefined}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <strong style={{ fontSize: 16 }}>{p.name}</strong>
                {p.current && <Pill tone="brand">Current</Pill>}
              </div>
              <strong style={{ fontSize: 24 }}>
                {price(p)}
                <span className="sub"> / month</span>
              </strong>
              <ul className="ticks">
                <li>{num(p.limits.aiCreditsPerMonth)} AI replies a month</li>
                <li>
                  {p.limits.pages} Facebook page{p.limits.pages === 1 ? '' : 's'}
                </li>
                <li>
                  {p.limits.staffSeats} team seat{p.limits.staffSeats === 1 ? '' : 's'}
                </li>
                <li>{p.limits.knowledgeBaseMb} MB knowledge base</li>
              </ul>
            </div>
          ))}
        </div>
        <span className="sub">
          Extra replies: {num(b.topUp.credits)} for {b.currency === 'BDT' ? bdt(b.topUp.priceBdt) : usd(b.topUp.priceUsd, 0)}.
        </span>
      </Section>
    </div>
  );
}
