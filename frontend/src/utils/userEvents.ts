import type { UserEvent, UserEventKind } from '@/types/auth';

/** The Events page's period presets; 'custom' means the From/To dates. */
export type EventPeriod = 'today' | '7d' | '30d' | 'all' | 'custom';

export const PERIODS: { id: Exclude<EventPeriod, 'custom'>; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'all', label: 'All' },
];

export const KIND_LABELS: Record<UserEventKind, string> = {
  login: 'Signed in',
  login_failed: 'Failed sign-in',
  logout: 'Signed out',
  document_created: 'Created',
  ai_call: 'AI call',
};

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** A 'YYYY-MM-DD' date input as the start of that day, local time (or null). */
export function localDay(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The since/until (ISO; until exclusive) for a period, counted in whole local
 *  days: "7 days" is today and the six days before. Custom uses from/to dates,
 *  both included. */
export function periodRange(period: EventPeriod, now: Date, from = '', to = ''): { since?: string; until?: string } {
  const today = startOfDay(now);
  const daysBack = (n: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - n).toISOString();
  switch (period) {
    case 'today': return { since: today.toISOString() };
    case '7d': return { since: daysBack(6) };
    case '30d': return { since: daysBack(29) };
    case 'all': return {};
    case 'custom': {
      const a = localDay(from);
      const b = localDay(to);
      return {
        ...(a ? { since: a.toISOString() } : {}),
        ...(b ? { until: new Date(b.getFullYear(), b.getMonth(), b.getDate() + 1).toISOString() } : {}),
      };
    }
  }
}

/** Dollars: more places for small sums, so a cent-sized call isn't "$0.00". */
export function formatCost(usd: number): string {
  if (!usd) return '$0';
  if (usd < 0.1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function tokens(n: number): string {
  return n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString('en-US');
}

/** "part chat · claude-opus-5 · 3,000 in (1,000 cached) · 400 out" for an AI call. */
export function aiCallSummary(e: UserEvent): string {
  const d = e.detail;
  const parts: string[] = [];
  if (d.source) parts.push(d.source);
  if (d.model) parts.push(d.model);
  if (d.tokens_in != null) {
    const cached = d.cache_read_tokens ? ` (${tokens(d.cache_read_tokens)} cached)` : '';
    parts.push(`${tokens(d.tokens_in)} in${cached}`);
  }
  if (d.tokens_out != null) parts.push(`${tokens(d.tokens_out)} out`);
  if (d.failed) parts.push('failed');
  if (d.backfilled) parts.push('from the earlier log');
  return parts.join(' · ');
}

/** A short browser name from a user agent, e.g. "Chrome on macOS". */
export function browserName(ua: string): string {
  if (!ua) return '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari' : '';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return [browser, os].filter(Boolean).join(' on ');
}
