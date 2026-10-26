import { describe, expect, it } from 'vitest';
import type { GenRunResult } from '@/types/generated';
import { proposalMessage, runWords } from './SketchChat';

const run: GenRunResult = {
  ok: true, profile: {}, entities: [], annotations: { labels: [], dims: [] }, reads: { w: 100 },
  outputs: [{ name: 'plate', description: '', kind: 'shapes', count: 1, size: '100 × 60 mm' }],
  checks: [{ name: 'bed', ok: true, message: '' }, { name: 'edge', ok: false, message: '1.2 mm' }],
};

describe('sketch chat words', () => {
  it('says how the checks went', () => {
    expect(runWords(run)).toBe('1 of 2 checks pass (fails: edge).');
    expect(runWords({ ...run, checks: [run.checks[0]!] })).toBe('The check passes.');
    expect(runWords({ ok: false, error: 'x', line: 1, reads: {} })).toBe('');
  });

  it('turns a proposal into a message to accept or decline', () => {
    const m = proposalMessage({ kind: 'proposal', sentence: "I'll make this a generated sketch.", name: 'Frame layout',
                                code: 'output()', empty: true, result: run, context_files: [] }, 1);
    expect(m.text).toBe("I'll make this a generated sketch.");
    expect(m.proposal).toEqual({ name: 'Frame layout', code: 'output()', empty: true, outputs: ['plate (100 × 60 mm)'],
                                 checks: '1 of 2 checks pass (fails: edge).', status: 'pending' });
  });
});
