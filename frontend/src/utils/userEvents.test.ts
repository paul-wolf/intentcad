import { describe, expect, it } from 'vitest';
import type { UserEvent } from '@/types/auth';
import { aiCallSummary, browserName, formatCost, localDay, periodRange } from './userEvents';

const NOW = new Date(2026, 9, 22, 15, 30);   // 22 Oct 2026, 15:30 local

describe('periodRange', () => {
  it('counts whole local days', () => {
    expect(periodRange('today', NOW)).toEqual({ since: new Date(2026, 9, 22).toISOString() });
    expect(periodRange('7d', NOW)).toEqual({ since: new Date(2026, 9, 16).toISOString() });
    expect(periodRange('30d', NOW)).toEqual({ since: new Date(2026, 8, 23).toISOString() });
    expect(periodRange('all', NOW)).toEqual({});
  });

  it('includes both custom dates', () => {
    expect(periodRange('custom', NOW, '2026-10-01', '2026-10-03')).toEqual({
      since: new Date(2026, 9, 1).toISOString(),
      until: new Date(2026, 9, 4).toISOString(),
    });
    expect(periodRange('custom', NOW, '', '2026-10-31')).toEqual({ until: new Date(2026, 10, 1).toISOString() });
    expect(periodRange('custom', NOW, 'nonsense')).toEqual({});
  });
});

describe('localDay', () => {
  it('reads a date input', () => {
    expect(localDay('2026-02-03')?.getDate()).toBe(3);
    expect(localDay('')).toBeNull();
  });
});

describe('formatCost', () => {
  it('shows small sums with more places', () => {
    expect(formatCost(0)).toBe('$0');
    expect(formatCost(0.0042)).toBe('$0.004');
    expect(formatCost(0.25)).toBe('$0.25');
    expect(formatCost(12.345)).toBe('$12.35');
  });
});

describe('aiCallSummary', () => {
  it('names the source, model and tokens', () => {
    const e = { detail: { source: 'part chat', model: 'claude-opus-5', tokens_in: 3000, tokens_out: 400,
                          cache_read_tokens: 1000, failed: true } } as UserEvent;
    expect(aiCallSummary(e)).toBe('part chat · claude-opus-5 · 3,000 in (1,000 cached) · 400 out · failed');
    expect(aiCallSummary({ detail: { tokens_in: 51_000, tokens_out: 100, backfilled: true } } as UserEvent))
      .toBe('51k in · 100 out · from the earlier log');
  });
});

describe('browserName', () => {
  it('names the browser and system', () => {
    expect(browserName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36'))
      .toBe('Chrome on macOS');
    expect(browserName('')).toBe('');
  });
});
