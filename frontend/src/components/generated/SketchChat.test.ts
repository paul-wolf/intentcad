import { describe, expect, it } from 'vitest';
import type { GenRunResult } from '@/types/generated';
import { heldBecause, projectCards, proposalMessage, runWords } from './SketchChat';

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

  it('gives every kind of reply its project cards: one for all the parameters, one for the brief', () => {
    const items = [{ name: 'prop_d', value: 406.4, unit: 'mm' as const, reason: 'pasted' },
                   { name: 'arm_count', value: 6, unit: '' as const, reason: 'pasted' }];
    for (const kind of ['answer', 'question', 'edit', 'proposal'] as const) {
      const cards = projectCards({ kind, context_files: [], parameter_proposals: items,
                                   brief_proposal: { text: 'New brief', reason: 'arms' } }, 'Old brief');
      expect(cards.params).toEqual({ items, status: 'pending' });
      expect(cards.brief).toEqual({ text: 'New brief', reason: 'arms', base: 'Old brief', status: 'pending' });
    }
    expect(projectCards({ kind: 'answer', context_files: [] }, 'Old brief')).toEqual({});
    // outside a project there is no brief to change
    expect(projectCards({ kind: 'answer', context_files: [], brief_proposal: { text: 'x', reason: '' } }, null)).toEqual({});
  });
});

describe('an AI edit of a generated sketch', () => {
  it('waits on its card when the editor has code the AI did not edit', () => {
    expect(heldBecause('saved', 'saved', 'saved')).toBeNull();                       // nothing changed: saved
    expect(heldBecause('typing', 'saved', 'typing')).toBeNull();                     // asked again on the unsaved code
    expect(heldBecause('typing', 'saved', 'saved')).toEqual({ changed: true, unsaved: true });
    expect(heldBecause('saved2', 'saved2', 'saved')).toEqual({ changed: true });     // saved here while it worked
  });
});
