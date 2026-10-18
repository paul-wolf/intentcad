import type { Entity, Point } from '@/types/document';
import { createRotatedEntity } from './propagate';

/** The copies a circular copy makes of `ids`: `count` positions evenly round
 *  `center`, the first being the originals themselves. Dimensions are not copied. */
export function circularCopies(
  entities: Entity[],
  ids: string[],
  center: Point,
  count: number,
  newId: () => string = () => crypto.randomUUID(),
): Entity[] {
  const out: Entity[] = [];
  for (const id of ids) {
    const source = entities.find((e) => e.id === id);
    if (!source) continue;
    for (let i = 1; i < count; i++) {
      const angle = (2 * Math.PI / count) * i;
      const copy = createRotatedEntity(source, { type: 'rotate', center, angle }, newId());
      if (copy) out.push(copy);
    }
  }
  return out;
}
