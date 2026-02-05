import type { Document, Entity, Sketch, Constraint } from '@/types/document';
import { generateId } from './id';

export function createEmptySketch(name: string): Sketch {
  return {
    id: generateId('sk'),
    name,
    visible: true,
    entities: [],
    constraints: [],
  };
}

/** Migrate a document from the old start/end line format to points[]. */
export function migrateDocument(doc: Document): Document {
  return {
    ...doc,
    parameters: doc.parameters ?? {},
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
