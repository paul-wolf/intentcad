import { describe, expect, it, beforeEach } from 'vitest';
import type { FaceRefSpec } from '@/api/client';
import type { Sketch } from '@/types/document';
import {
  advance, aliasIn, parseSkSource, pickFor, placed, readHandoff, saveHandoff, sharedAsSketch, skSource, skWords,
  toShared, type Handoff, type SkSource,
} from './sketchToPart';

const sketch = {
  id: 'frame', name: 'Frame', entities: [
    { id: 'o', type: 'line', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], closed: true, name: 'outline' },
    { id: 'h1', type: 'circle', center: { x: 2, y: 2 }, radius: 1 },
    { id: 'h2', type: 'circle', center: { x: 8, y: 2 }, radius: 1 },
  ],
  constraints: [], groups: [{ name: 'arm holes', ids: ['h1', 'h2'] }],
} as unknown as Sketch;

describe('shared sketch sources', () => {
  it('writes and reads back the forms the backend writes', () => {
    const face: FaceRefSpec = { normal: [0, 0, 1], center: [0, 0, 2.5], area: 6400, hint: 'top face' };
    for (const s of <SkSource[]>[
      { alias: 'frame', pick: null, on: null },
      { alias: 'frame', pick: { kind: 'group' as const, name: 'arm holes' }, on: null },
      { alias: 'fr"ame', pick: { kind: 'named' as const, name: 'outline' }, on: { plane: 'Mid' } },
      { alias: 'frame', pick: null, on: { face } },
      { alias: 'frame', pick: null, on: { base: 'XZ' } },
    ]) {
      expect(parseSkSource(skSource(s))).toEqual(s);
    }
    expect(skSource({ alias: 'frame', pick: { kind: 'group', name: 'arm holes' }, on: { plane: 'Mid' } }))
      .toBe('SK["frame"].group("arm holes").on(PLANES["Mid"])');
    expect(skSource({ alias: 'f', pick: null, on: { face } }))
      .toBe('SK["f"].on(face_ref({"normal": [0, 0, 1], "center": [0, 0, 2.5], "area": 6400, "hint": "top face"}))');
    expect(parseSkSource('sketch("Holes")')).toBeNull();
    expect(parseSkSource('SK["f"].circles')).toBeNull();
  });

  it('moves a source to another placement and says it in words', () => {
    expect(placed('SK["frame"].group("arm holes")', { plane: 'Mid' })).toBe('SK["frame"].group("arm holes").on(PLANES["Mid"])');
    expect(placed('SK["frame"].on(PLANES["Mid"])', null)).toBe('SK["frame"]');
    expect(skWords('SK["frame"].group("arm holes").on(PLANES["Mid"])')).toBe('frame · arm holes');
    expect(skWords('SK["frame"]')).toBe('frame');
  });

  it('shows the dialogs only the picked elements, on the placed plane', () => {
    const g = sharedAsSketch(sketch, 'SK["frame"].group("arm holes")');
    expect(g.entities.map((e) => e.id)).toEqual(['h1', 'h2']);
    expect(g.name).toBe('SK["frame"].group("arm holes")');
    expect(g.plane).toEqual({ origin: [0, 0, 0], normal: [0, 0, 1], xAxis: [1, 0, 0] });
    expect(sharedAsSketch(sketch, 'SK["frame"].named("outline")').entities.map((e) => e.id)).toEqual(['o']);
    expect(sharedAsSketch(sketch, 'SK["frame"].on(PLANES["Mid"])').planeRef).toBe('Mid');
    expect(sharedAsSketch(sketch, 'SK["frame"].on(Plane.XZ)').plane?.normal).toEqual([0, -1, 0]);
  });

  it('picks the group or named element that is selected', () => {
    expect(pickFor(sketch, ['h2', 'h1'])).toEqual({ kind: 'group', name: 'arm holes' });
    expect(pickFor(sketch, ['o'])).toEqual({ kind: 'named', name: 'outline' });
    expect(pickFor(sketch, ['h1'])).toBeNull();
    expect(pickFor(sketch, [])).toBeNull();
  });

  it('reuses the alias a part has for the sketch, else a free one', () => {
    const ref = { document: 'd1', sketch: 'frame' };
    expect(aliasIn({ holes: ref }, ref, 'frame')).toEqual({ alias: 'holes', added: false });
    expect(aliasIn({ frame: { document: 'd2', sketch: 'x' } }, ref, 'frame')).toEqual({ alias: 'frame_2', added: true });
    expect(aliasIn({}, ref, 'frame')).toEqual({ alias: 'frame', added: true });
  });

  it('switches a face sketch to its saved project copy in the script', () => {
    const code = [
      'part -= extrude(sketch("Vent"), amount=-P["d"])',
      "part += revolve(sketch('Vent'), axis=sketch_line(\"Vent\", \"axis-v\"), angle=360)",
      'part = holes(part, sketch_points("Vent"), d=3)',
      'part -= extrude(sketch("Vent 2"), amount=-1)',
    ].join('\n');
    expect(toShared(code, 'Vent', 'vent').split('\n')).toEqual([
      'part -= extrude(SK["vent"], amount=-P["d"])',
      'part += revolve(SK["vent"], axis=SK["vent"].line("axis-v"), angle=360)',
      'part = holes(part, SK["vent"].points, d=3)',
      'part -= extrude(sketch("Vent 2"), amount=-1)',
    ]);
  });
});

describe('the handoff', () => {
  beforeEach(() => {
    const m = new Map<string, string>();
    (globalThis as { sessionStorage?: unknown }).sessionStorage = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
  });
  const h: Handoff = {
    op: 'cut', sketchDoc: 'd1', sketchId: 'frame', sketchName: 'Frame', alias: 'frame', pick: null,
    parts: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], at: 0, done: [], skipped: [],
  };
  it('keeps ids only, across a page load, until cleared', () => {
    saveHandoff(h);
    expect(readHandoff()).toEqual(h);
    saveHandoff(null);
    expect(readHandoff()).toBeNull();
  });
  it('moves on, remembering what was done and skipped', () => {
    const next = advance(advance(h, 'done'), 'skipped');
    expect(next.at).toBe(2);
    expect(next.done).toEqual(['a']);
    expect(next.skipped).toEqual(['b']);
  });
});
