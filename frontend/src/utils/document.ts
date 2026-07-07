import type { Document, Entity, Sketch, Constraint } from '@/types/document';
import type { Plane } from '@/types/geometry';
import { generateId } from './id';

export function generateUniqueName(baseName: string, existingNames: string[]): string {
  const nameSet = new Set(existingNames);
  if (!nameSet.has(baseName)) return baseName;
  for (let i = 2; ; i++) {
    const candidate = `${baseName} ${i}`;
    if (!nameSet.has(candidate)) return candidate;
  }
}

/** A clean, guaranteed-unique auto name like "Part 1", "Part 2", … — numbered
 *  from the lowest free integer among the given names. Used for new documents so
 *  two parts created the same day never share a name. */
export function generateNumberedName(base: string, existingNames: string[]): string {
  const taken = new Set(existingNames);
  for (let i = 1; ; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function generateDateName(existingNames: string[]): string {
  const base = new Date().toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
  const nameSet = new Set(existingNames);
  if (!nameSet.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base} (${i})`;
    if (!nameSet.has(candidate)) return candidate;
  }
}

export function createEmptySketch(name: string, plane?: Plane): Sketch {
  const sketch: Sketch = {
    id: generateId('sk'),
    name,
    visible: true,
    entities: [],
    constraints: [],
  };
  if (plane) sketch.plane = plane;
  return sketch;
}

/** Migrate a document from the old start/end line format to points[]. */
export function migrateDocument(doc: Document): Document {
  return {
    ...doc,
    parameters: doc.parameters ?? {},
    buildFeatures: doc.buildFeatures ?? [],
    sketches: doc.sketches.map((sk) => ({
      ...sk,
      constraints: (sk as unknown as { constraints?: Constraint[] }).constraints ?? [],
      entities: sk.entities.map((e): Entity => {
        if (e.type === 'line' && !e.points) {
          const legacy = e as unknown as { start: { x: number; y: number }; end: { x: number; y: number } };
          return { id: e.id, type: 'line', points: [legacy.start, legacy.end] };
        }
        return e;
      }),
    })),
  };
}

export function createEmptyDocument(name: string): Document {
  const sketch = createEmptySketch('Sketch 1');
  return {
    id: generateId('doc'),
    name,
    sketches: [sketch],
    activeSketchId: sketch.id,
    parameters: {},
  };
}

/** Default target-process brief for a new part. Fed to the AI as standing
 *  context so it designs in real clearances. Editable per part in the editor. */
export const DEFAULT_PRODUCTION_NOTES =
  `Target process: FDM 3D printing (filament). Design in real clearances — plastic swells and the first layer squishes:
- Holes/bores print undersized: add ~0.3–0.5 mm to the diameter of any hole meant to accept a rod, pin, bolt or shaft.
- Moving or press-together fits (hinges, sliders, lids, snap parts): leave ~0.4 mm total clearance between mating faces.
- No knife edges or paper-thin walls (keep walls ≥ ~1.2 mm, ~3 perimeters).
- Mind elephant's foot at the base; prefer self-supporting angles (overhangs beyond ~45° need support).
- Expose every fit/clearance as a named param in P so it can be tuned to the printer without rewriting the script.`;

/** A new 3D part document. It still carries an empty sketch (so it validates and
 *  can reference sketches later); `type: 'part'` marks it for the list + routing. */
export function createEmptyPart(name: string): Document {
  return { ...createEmptyDocument(name), type: 'part', productionNotes: DEFAULT_PRODUCTION_NOTES };
}
