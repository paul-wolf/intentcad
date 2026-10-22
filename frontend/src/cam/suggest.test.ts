import { describe, it, expect } from 'vitest';
import { applyCamSuggestion, createDefaultJobConfig, normalizeCamJobConfig } from '@/types/cam';

const current = () => {
  const c = createDefaultJobConfig();
  c.selectedSketchIds = ['s1'];
  c.origin = { x: 5, y: 5 };
  return c;
};
const known = new Set(['r1', 'c1']);

describe('applyCamSuggestion', () => {
  it('accepts the old advisor format (shared tool, operations without cutting) without losing fields', () => {
    const raw = {
      tool: { name: '6mm', diameter: 6, type: 'flat', fluteCount: 2, fluteLength: 20 },
      machine: { spindleSpeed: 16000, feedRate: 1200, plungeRate: 300, safeZ: 6, useFloodCoolant: false },
      depth: { totalDepth: 6, depthPerPass: 2, finalPassAllowance: 0 },
      stock: { thickness: 6, zTop: 0 },
      postProcessor: { arcOutput: 'linearize' },
      operations: [{ kind: 'profile', entityIds: ['r1'], sketchId: '...', cutSide: 'outside' }],
    };
    const { config } = applyCamSuggestion(current(), raw, known);
    const op = config.operations[0]!;
    expect(op.kind).toBe('profile');
    expect(op.cutting.tool.diameter).toBe(6);
    expect(op.cutting.feedRate).toBe(1200);
    expect(op.cutting.depth.totalDepth).toBe(6);
    expect(config.stock.thickness).toBe(6);
    // What the user set is kept; the post-processor is never taken from the AI.
    expect(config.selectedSketchIds).toEqual(['s1']);
    expect(config.origin).toEqual({ x: 5, y: 5 });
    expect(config.postProcessor).toEqual(current().postProcessor);
    expect('arcOutput' in config.postProcessor).toBe(false);
  });

  it('carries the profile direction and tabs', () => {
    const raw = {
      operations: [{
        kind: 'profile', entityIds: ['r1'], cutSide: 'outside', cutDirection: 'conventional',
        tabs: true, tabCount: 6, tabWidth: 4, tabHeight: 1.5,
      }],
    };
    const op = applyCamSuggestion(current(), raw, known).config.operations[0]!;
    expect(op).toMatchObject({ kind: 'profile', cutDirection: 'conventional', tabs: true, tabCount: 6, tabWidth: 4, tabHeight: 1.5 });
  });

  it('gives a profile without those fields climb, no tabs and 4 tabs ready', () => {
    const op = applyCamSuggestion(current(), { operations: [{ kind: 'profile', entityIds: ['r1'] }] }, known).config.operations[0]!;
    expect(op).toMatchObject({ kind: 'profile', cutSide: 'outside', cutDirection: 'climb', tabs: false, tabCount: 4, tabWidth: 5, tabHeight: 1 });
  });

  it('replaces nonsense tab and direction values with defaults', () => {
    const raw = {
      operations: [{
        kind: 'profile', entityIds: ['r1'], cutDirection: 'sideways',
        tabs: 'yes', tabCount: 2.5, tabWidth: -3, tabHeight: 'tall',
      }],
    };
    const op = applyCamSuggestion(current(), raw, known).config.operations[0]!;
    expect(op).toMatchObject({ cutDirection: 'climb', tabs: false, tabCount: 4, tabWidth: 5, tabHeight: 1 });
  });

  it('never takes the post-processor or the stock top from the AI', () => {
    const c = current();
    c.stock.zTop = 12;
    const raw = {
      postProcessor: { dialect: 'marlin', header: 'M3 S30000', footer: '' },
      stock: { thickness: 9, zTop: -40 },
      operations: [{ kind: 'drill', entityIds: ['c1'] }],
    };
    const { config } = applyCamSuggestion(c, raw, known);
    expect(config.postProcessor).toEqual(c.postProcessor);
    expect(config.stock).toEqual({ thickness: 9, zTop: 12 });
  });

  it('drops shapes that do not exist and operations left with none', () => {
    const raw = {
      operations: [
        { kind: 'drill', entityIds: ['c1', 'ghost'] },
        { kind: 'pocket', entityIds: ['ghost'] },
        { kind: 'laser', entityIds: ['r1'] },
      ],
    };
    const { config, notes } = applyCamSuggestion(current(), raw, known);
    expect(config.operations.map((o) => [o.kind, o.entityIds])).toEqual([['drill', ['c1']]]);
    expect(notes.length).toBe(2);
  });

  it('keeps the current operations when nothing usable comes back', () => {
    const c = current();
    c.operations = [{ ...applyCamSuggestion(c, { operations: [{ kind: 'drill', entityIds: ['c1'] }] }, known).config.operations[0]! }];
    const { config, notes } = applyCamSuggestion(c, { operations: [] }, known);
    expect(config.operations).toEqual(c.operations);
    expect(notes.some((n) => /kept your operations/.test(n))).toBe(true);
  });

  it('survives garbage', () => {
    for (const raw of [null, 'x', 42, { operations: 'no' }, { operations: [null, 1, { kind: 'profile' }] }]) {
      expect(() => applyCamSuggestion(current(), raw, known)).not.toThrow();
    }
  });
});

describe('normalizeCamJobConfig', () => {
  it('completes saved operations that have no cutting block', () => {
    const cfg = normalizeCamJobConfig({
      selectedSketchIds: ['s1'],
      operations: [{ kind: 'pocket', entityIds: ['r1'], sketchId: 's1' }],
    });
    expect(cfg.operations[0]!.cutting.tool.diameter).toBe(3);
    expect(cfg.stock.thickness).toBe(3);
    expect(cfg.postProcessor.dialect).toBe('grbl');
  });

  it('keeps a saved profile\'s tabs and direction', () => {
    const cfg = normalizeCamJobConfig({
      selectedSketchIds: ['s1'],
      operations: [{
        kind: 'profile', entityIds: ['r1'], sketchId: 's1', cutSide: 'outside', cutDirection: 'conventional',
        tabs: true, tabCount: 3, tabWidth: 6, tabHeight: 2,
      }],
    });
    expect(cfg.operations[0]).toMatchObject({ cutDirection: 'conventional', tabs: true, tabCount: 3, tabWidth: 6, tabHeight: 2 });
  });

  it('migrates a job saved before phase 2 (arc output setting, no direction or tab count)', () => {
    const cfg = normalizeCamJobConfig({
      selectedSketchIds: ['s1'],
      stock: { thickness: 6 },
      postProcessor: { dialect: 'grbl', decimalPlaces: 3, header: '', footer: '', arcOutput: 'linearize', linearizeTolerance: 0.01 },
      operations: [{ kind: 'profile', entityIds: ['r1'], sketchId: 's1', cutSide: 'inside', tabs: true, tabWidth: 5, tabHeight: 1 }],
    });
    expect(cfg.postProcessor).toEqual({ dialect: 'grbl', decimalPlaces: 3, header: '', footer: '' });
    expect(cfg.stock).toEqual({ thickness: 6, zTop: 0 });
    expect(cfg.operations[0]).toMatchObject({ cutDirection: 'climb', tabs: true, tabCount: 4 });
  });
});
