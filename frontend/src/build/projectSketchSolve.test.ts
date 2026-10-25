import { describe, it, expect, beforeEach } from 'vitest';
import type { Document, RectangleEntity, Sketch } from '@/types/document';
import type { ProjectParameter } from '@/types/project';
import { isSolvedFor, sketchProjectNames, solveDocument, solveWithProject, solvedWords, stampSolvedWith,
         unitMismatch, unitWarnings } from './projectSketchSolve';
import { resolveSketch } from '@/utils/resolveSketch';
import { useDocumentStore } from '@/stores/documentStore';

// a 20 x 10 plate whose width is the project's `w`
function plate(expression = 'w', extra: Partial<Sketch> = {}): Sketch {
  return {
    id: 'sk1', name: 'Plate', visible: true,
    entities: [
      { id: 'r', type: 'rectangle', center: { x: 0, y: 0 }, width: 20, height: 10 },
      { id: 'd1', type: 'dimension', targetEntityId: 'r', segmentIndex: 0, offset: 3, expression },
    ],
    constraints: [],
    ...extra,
  } as Sketch;
}
const P = (w: number | string, unit: ProjectParameter['unit'] = 'mm'): ProjectParameter[] =>
  [{ name: 'w', value: w, unit }, { name: 'thick', value: 2, unit: 'mm' }];
const width = (s: Sketch) => (s.entities.find((e) => e.id === 'r') as RectangleEntity).width;
const doc = (sketches: Sketch[], parameters?: Record<string, number>): Document =>
  ({ name: 'Plate', type: 'sketch', sketches, activeSketchId: sketches[0]!.id, parameters } as unknown as Document);

describe('resolveSketch failures', () => {
  it('records a dimension whose expression comes to nothing usable', () => {
    const r = resolveSketch(plate('w - 50'), { w: 30 });
    expect(r.changed).toBe(false);
    expect(r.failures.map((f) => [f.dimensionId, f.expression])).toEqual([['d1', 'w - 50']]);
    expect(r.failures[0]!.message).toMatch(/-20/);
  });

  it('has none when every dimension is met', () => {
    const r = resolveSketch(plate(), { w: 30 });
    expect(r.failures).toEqual([]);
    expect(width(r.sketch)).toBeCloseTo(30, 6);
  });
});

describe('solveWithProject', () => {
  it('solves with the project value and records it', () => {
    const r = solveWithProject(plate(), P(30));
    expect(r.error).toBeNull();
    expect(r.changed).toBe(true);
    expect(width(r.sketch)).toBeCloseTo(30, 6);
    expect(r.sketch.solvedWith).toEqual({ w: 30 });
    expect(isSolvedFor(r.sketch, P(30))).toBe(true);
    expect(isSolvedFor(r.sketch, P(31))).toBe(false);
    // again: nothing to do
    expect(solveWithProject(r.sketch, P(30)).changed).toBe(false);
  });

  it("keeps the last good shape when the value can't be met, and says why", () => {
    const good = solveWithProject(plate('w - 25'), P(45)).sketch;
    expect(width(good)).toBeCloseTo(20, 6);
    const r = solveWithProject(good, P(10));
    expect(r.error?.with).toEqual({ w: 10 });
    expect(r.error?.dimensionIds).toEqual(['d1']);
    expect(width(r.sketch)).toBeCloseTo(20, 6);           // last good geometry
    expect(r.sketch.solvedWith).toEqual({ w: 45 });       // still what it was solved with
    expect(r.sketch.solveError?.message).toBe(r.error?.message);
    // a good value again clears the error
    const back = solveWithProject(r.sketch, P(55));
    expect(back.error).toBeNull();
    expect(back.sketch.solveError).toBeUndefined();
    expect(width(back.sketch)).toBeCloseTo(30, 6);
  });

  it('a text value or a deleted parameter is a failure', () => {
    expect(solveWithProject(plate(), P('M3')).error?.message).toMatch(/text \(M3\)/);
    const solved = solveWithProject(plate(), P(30)).sketch;
    const gone = solveWithProject(solved, [{ name: 'thick', value: 2, unit: 'mm' }]);
    expect(gone.error?.message).toMatch(/no longer a project parameter/);
    expect(gone.error?.with).toEqual({ w: null });
  });

  it("the sketch's own parameter of the name is its own business", () => {
    expect(sketchProjectNames(plate(), P(30), { w: 25 })).toEqual([]);
    const r = solveWithProject(plate(), P(30), { w: 25 });
    expect(r.sketch.solvedWith).toBeUndefined();
  });
});

describe('solveDocument and stampSolvedWith', () => {
  it('solves every sketch and lists the ones that fail', () => {
    const d = doc([plate(), plate('w - 50', { id: 'sk2', name: 'Narrow' })]);
    const r = solveDocument(d, P(30));
    expect(r.changed).toBe(true);
    expect(r.failed.map(([n]) => n)).toEqual(['Narrow']);
    expect(width(r.document.sketches[0]!)).toBeCloseTo(30, 6);
  });

  it('stamps the values a newly used name was set with', () => {
    const d = stampSolvedWith(doc([plate()]), P(20));
    expect(d.sketches[0]!.solvedWith).toEqual({ w: 20 });
    // nothing used: nothing stamped
    const plain = doc([plate('12')]);
    expect(stampSolvedWith(plain, P(20))).toBe(plain);
  });
});

describe('units', () => {
  it('warns of a degree parameter in a length, and a mm one in an angle', () => {
    expect(unitWarnings(plate(), P(30, 'deg')).map((w) => w.message)).toEqual(['w is in degrees, but this dimension is a length']);
    expect(unitWarnings(plate(), P(30))).toEqual([]);
    expect(unitMismatch('a', 'mm', true)).toBe('a is in mm, but this dimension is an angle');
    expect(unitMismatch('n', '', false)).toBeNull();
  });
});

describe('solvedWords', () => {
  it('is empty when all went well', () => {
    expect(solvedWords({ failed: [], errors: [] })).toBe('');
    expect(solvedWords({ failed: ['Plate: no'], errors: [] })).toBe("can't be solved: Plate: no");
  });
});

describe('renameProjectParameter', () => {
  beforeEach(() => {
    useDocumentStore.setState({ document: doc([{ ...plate('w/2 + w_2'), solvedWith: { w: 30 } }]) });
  });

  it("rewrites the name in dimensions and in what the sketch was solved with", () => {
    useDocumentStore.getState().renameProjectParameter('w', 'plate_w');
    const s = useDocumentStore.getState().document.sketches[0]!;
    expect(s.entities.find((e) => e.id === 'd1')).toMatchObject({ expression: 'plate_w/2 + w_2' });
    expect(s.solvedWith).toEqual({ plate_w: 30 });
  });

  it("leaves the document's own parameter of that name alone", () => {
    useDocumentStore.setState({ document: { ...useDocumentStore.getState().document, parameters: { w: 5 } } });
    useDocumentStore.getState().renameProjectParameter('w', 'plate_w');
    expect(useDocumentStore.getState().document.sketches[0]!.entities.find((e) => e.id === 'd1')).toMatchObject({ expression: 'w/2 + w_2' });
  });
});

describe('project page renames', () => {
  it('a changed name is a rename; a new row or a swap back is not', async () => {
    const { renamesOf, usesWords } = await import('@/components/ProjectParameters');
    const row = (name: string, was?: string) => ({ name, value: '1', unit: 'mm' as const, description: '', was });
    expect(renamesOf([row('plate_w', 'w'), row('thick', 'thick'), row('new')])).toEqual({ w: 'plate_w' });
    expect(renamesOf([row('w', 'w'), row('', 'thick')])).toEqual({});
    expect(usesWords({ sketches: [{ id: '1', sketch: 's', name: 'Frame', state: 'ok', message: '' }],
                       parts: [{ id: '2', name: 'Plate', via: ['script'] }] })).toBe('sketches Frame; parts Plate');
  });
});
