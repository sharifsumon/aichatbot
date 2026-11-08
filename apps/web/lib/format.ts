/** Display helpers. Dates show in the viewer's own time zone. */

const nf = new Intl.NumberFormat('en');

export const num = (n: number | string | null | undefined) => nf.format(Number(n ?? 0));

export function bdt(amount: string | number | null | undefined): string {
  return `৳${nf.format(Math.round(Number(amount ?? 0)))}`;
}

export function usd(amount: string | number | null | undefined, digits = 2): string {
  return `$${Number(amount ?? 0).toFixed(digits)}`;
}

export function ago(value: string | Date | null | undefined): string {
  if (!value) return 'Never';
  const ms = Date.now() - new Date(value).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'Just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return h === 1 ? '1 hour ago' : `${h} hours ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'Yesterday';
  if (d < 30) return `${d} days ago`;
  return date(value);
}

export function date(value: string | Date | null | undefined): string {
  if (!value) return '';
  return new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function dateTime(value: string | Date | null | undefined): string {
  if (!value) return '';
  return new Date(value).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function daysLeft(value: string | Date | null | undefined): number | null {
  if (!value) return null;
  return Math.max(0, Math.ceil((new Date(value).getTime() - Date.now()) / 864e5));
}

export const percent = (part: number, whole: number) => (whole > 0 ? Math.min(100, Math.round((part / whole) * 100)) : part > 0 ? 100 : 0);

/** "tenant.credits_adjusted" → "Tenant credits adjusted" */
export function actionLabel(action: string): string {
  const s = action.replace(/[._]/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}
