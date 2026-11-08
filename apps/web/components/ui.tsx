'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { percent } from '@/lib/format';
import type { ShopStatus } from '@/lib/types';

export function TopBar({ title, children, back }: { title: string; children?: ReactNode; back?: { href: string; label: string } }) {
  return (
    <header className="top">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {back && (
          <a className="crumb" href={back.href}>
            ← {back.label}
          </a>
        )}
        <h1>{title}</h1>
      </div>
      {children && <div className="right">{children}</div>}
    </header>
  );
}

export function Stat({ label, value, note, tone }: { label: string; value: ReactNode; note?: ReactNode; tone?: 'warn' | 'bad' }) {
  return (
    <div className={`stat${tone ? ` ${tone}` : ''}`}>
      <span>{label}</span>
      <strong className="num">{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}

export function Pill({ tone, children }: { tone?: 'green' | 'red' | 'amber' | 'blue' | 'violet' | 'brand'; children: ReactNode }) {
  return <span className={`pill${tone ? ` ${tone}` : ''}`}>{children}</span>;
}

/** The shop's own account state, in the shop owner's words. */
export function ShopStatusPill({ status, trialDaysLeft }: { status: ShopStatus; trialDaysLeft?: number | null }) {
  if (status === 'suspended') return <Pill tone="red">Suspended</Pill>;
  if (status === 'past_due') return <Pill tone="amber">Payment overdue</Pill>;
  if (status === 'trial') {
    if (trialDaysLeft === 0) return <Pill tone="amber">Trial ended</Pill>;
    return <Pill tone="blue">Free trial{trialDaysLeft != null ? ` · ${trialDaysLeft} day${trialDaysLeft === 1 ? '' : 's'} left` : ''}</Pill>;
  }
  return <Pill tone="green">Active</Pill>;
}

export function Meter({ used, total, label }: { used: number; total: number; label?: ReactNode }) {
  const p = percent(used, total);
  return (
    <div className="meter">
      <span className="num" style={{ fontSize: 13 }}>
        {label ?? `${used.toLocaleString('en')} / ${total.toLocaleString('en')}`}
      </span>
      <div className={`bar${p >= 100 ? ' full' : ''}`}>
        <div style={{ width: `${p}%` }} />
      </div>
    </div>
  );
}

export function Notice({ tone, children }: { tone: 'error' | 'ok' | 'warn' | 'info'; children: ReactNode }) {
  return (
    <div className={`notice ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function Loading({ what = 'Loading' }: { what?: string }) {
  return <div className="loading">{what}…</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** A bar per day; hover shows the value. */
export function DayChart<T extends { day: string }>({ days: raw, value, label, span }: { days: T[]; value: (d: T) => number; label: string; span: number }) {
  // One bar for every day in the period, so quiet days show as gaps.
  const byDay = new Map(raw.map((d) => [d.day, d]));
  const days = Array.from({ length: span }, (_, i) => new Date(Date.now() - (span - 1 - i) * 864e5).toISOString().slice(0, 10)).map((day) => ({ day, row: byDay.get(day) }));
  const values = days.map((d) => (d.row ? value(d.row) : 0));
  const max = Math.max(1, ...values);
  if (raw.length === 0) return <Empty>No {label.toLowerCase()} in this period.</Empty>;
  return (
    <div>
      <div className="chart" role="img" aria-label={`${label} per day`}>
        {days.map((d, i) => (
          <div key={d.day} className={values[i] ? '' : 'zero'} style={{ height: `${Math.max(2, (values[i]! / max) * 100)}%` }} title={`${d.day}: ${values[i]!.toLocaleString('en')}`} />
        ))}
      </div>
      <div className="chart-axis">
        <span>{days[0]!.day}</span>
        <span>{days.at(-1)!.day}</span>
      </div>
    </div>
  );
}

/**
 * A dialog with a form. `onSubmit` returns an error message to show, or
 * nothing to close. Escape and the backdrop close it.
 */
export function Dialog({
  title,
  submitLabel,
  danger,
  wide,
  onClose,
  onSubmit,
  children,
}: {
  title: string;
  submitLabel: string;
  danger?: boolean;
  wide?: boolean;
  onClose: () => void;
  onSubmit: () => Promise<string | void>;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const problem = await onSubmit();
      if (problem) setError(problem);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form className={`dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} onSubmit={submit}>
        <h2>{title}</h2>
        {children}
        {error && <Notice tone="error">{error}</Notice>}
        <div className="buttons">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className={`btn ${danger ? 'danger' : 'primary'}`} disabled={busy}>
            {busy ? 'Working…' : submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Search box that reports its value after typing pauses. */
export function SearchBox({ placeholder, label, initial = '', onSearch }: { placeholder: string; label: string; initial?: string; onSearch: (q: string) => void }) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    const t = setTimeout(() => onSearch(value.trim()), 300);
    return () => clearTimeout(t);
  }, [value, onSearch]);
  return (
    <label className="search">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-4-4" />
      </svg>
      <input aria-label={label} placeholder={placeholder} value={value} onChange={(e) => setValue(e.target.value)} />
    </label>
  );
}

export function Chips<T extends string>({ options, value, onChange, label }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className="chips" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className={`chip${o.value === value ? ' on' : ''}`} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A round avatar with initials, coloured by name so each customer is easy to spot. */
const AVATAR = [
  ['#DBEAFE', '#1D4ED8'],
  ['#FEF3C7', '#B54708'],
  ['#FCE7F3', '#9D174D'],
  ['#DCFCE7', '#067647'],
  ['#EDE9FE', '#5B21B6'],
  ['#FFE4E6', '#BE123C'],
] as const;

export function Avatar({ name, size = 40 }: { name: string | null | undefined; size?: number }) {
  const n = (name ?? '').trim() || '?';
  const initials = n
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  let h = 0;
  for (const ch of n) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [bg, fg] = AVATAR[h % AVATAR.length]!;
  return (
    <span className="av" style={{ width: size, height: size, flexBasis: size, background: bg, color: fg, fontSize: size < 36 ? 12 : 14 }} aria-hidden="true">
      {initials}
    </span>
  );
}

/** An on/off switch that is a real checkbox underneath. */
export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}
