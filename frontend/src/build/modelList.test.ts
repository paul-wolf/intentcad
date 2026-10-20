import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '@/api/client';
import { chooseModel, modelsStale } from './modelList';

const m = (id: string): ModelInfo => ({
  id, label: id, tier: 'opus', note: '', released: '2026-09-21', input_per_m: 4, output_per_m: 20,
});

describe('model list freshness', () => {
  it('asks again after 10 minutes, or after 1 minute for the static snapshot', () => {
    const t = 1_000_000;
    expect(modelsStale(0, null, t)).toBe(true);
    expect(modelsStale(t, 'live', t + 9 * 60_000)).toBe(false);
    expect(modelsStale(t, 'live', t + 11 * 60_000)).toBe(true);
    expect(modelsStale(t, 'static', t + 30_000)).toBe(false);
    expect(modelsStale(t, 'static', t + 61_000)).toBe(true);
  });
});

describe('which model is selected after a reload', () => {
  const r = { models: [m('claude-opus-5-5'), m('claude-opus-5')], default: 'claude-opus-5-5' };

  it('keeps the user’s own pick while it is offered', () => {
    expect(chooseModel('claude-opus-5', r, true)).toBe('claude-opus-5');
  });

  it('follows the new default when the user never picked', () => {
    expect(chooseModel('claude-opus-5', r, false)).toBe('claude-opus-5-5');
    expect(chooseModel('', r, false)).toBe('claude-opus-5-5');
  });

  it('falls back to the default when the pick is no longer offered', () => {
    expect(chooseModel('claude-opus-4-8', r, true)).toBe('claude-opus-5-5');
  });
});
