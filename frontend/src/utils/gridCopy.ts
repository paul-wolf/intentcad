import type { Entity } from '@/types/document';
import { createTranslatedEntity } from './propagate';

/** The copies a grid copy makes of `ids`: countX × countY positions spaced
 *  centre to centre, the first (0, 0) being the originals themselves.
 *  Dimensions are not copied. */
export function gridCopies(
  entities: Entity[],
  ids: string[],
  countX: number,
  countY: number,
  spacingX: number,
  spacingY: number,
  newId: () => string = () => crypto.randomUUID(),
): Entity[] {
  const out: Entity[] = [];
  for (const id of ids) {
    const source = entities.find((e) => e.id === id);
    if (!source) continue;
    for (let row = 0; row < countY; row++) {
      for (let col = 0; col < countX; col++) {
        if (row === 0 && col === 0) continue; // skip source position
        const copy = createTranslatedEntity(source, { type: 'translate', dx: col * spacingX, dy: row * spacingY }, newId());
        if (copy) out.push(copy);
      }
    }
  }
  return out;
}
