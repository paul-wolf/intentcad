import { describe, expect, it } from 'vitest';
import { createEmptyDocument, createEmptyPart, createEmptySketch, renamedTogether } from './document';

describe('one name for a one-sketch document', () => {
  it('renames the document with its only sketch, and the other way round', () => {
    const doc = createEmptyDocument('Sketch 1');
    const id = doc.sketches[0]!.id;
    const a = renamedTogether(doc, 'arm-brace', id);
    expect([a.name, a.sketches[0]!.name]).toEqual(['arm-brace', 'arm-brace']);
    const b = renamedTogether(a, 'Arm brace');
    expect([b.name, b.sketches[0]!.name]).toEqual(['Arm brace', 'Arm brace']);
  });
  it('leaves the names apart with several sketches, and in a part', () => {
    const doc = createEmptyDocument('Frame');
    const two = { ...doc, sketches: [...doc.sketches, createEmptySketch('Holes')] };
    const a = renamedTogether(two, 'Outline', two.sketches[0]!.id);
    expect([a.name, a.sketches[0]!.name, a.sketches[1]!.name]).toEqual(['Frame', 'Outline', 'Holes']);
    const part = createEmptyPart('Brace');
    const p = renamedTogether(part, 'Arm brace');
    expect([p.name, p.sketches[0]!.name]).toEqual(['Arm brace', part.sketches[0]!.name]);
  });
});
