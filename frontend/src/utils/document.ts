import type { Document, Entity, Sketch } from '@/types/document';
import { generateId } from './id';

export function createEmptySketch(name: string): Sketch {
  return {
    id: generateId('sk'),
    name,
    visible: true,
    entities: [],
  };
}

/** Migrate a document from the old start/end line format to points[]. */
export function migrateDocument(doc: Document): Document {
  return {
    ...doc,
    sketches: doc.sketches.map((sk) => ({
      ...sk,
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
  };
}
