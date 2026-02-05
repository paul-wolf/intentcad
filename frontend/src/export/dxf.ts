import type { Document } from '@/types/document';
import { getSegmentCount, getSegmentPointIndices } from '@/utils/lineSegments';

export function exportDocumentToDxf(doc: Document): string {
  const visibleSketches = doc.sketches.filter((sk) => !sk.suppressed);

  const lines: string[] = [];
  const w = (s: string) => lines.push(s);

  // HEADER section
  w('0');
  w('SECTION');
  w('2');
  w('HEADER');
  w('9');
  w('$ACADVER');
  w('1');
  w('AC1009');
  w('9');
  w('$INSUNITS');
  w('70');
  w('4');
  w('0');
  w('ENDSEC');

  // TABLES section
  w('0');
  w('SECTION');
  w('2');
  w('TABLES');

  // LTYPE table
  w('0');
  w('TABLE');
  w('2');
  w('LTYPE');
  w('70');
  w('1');
  w('0');
  w('LTYPE');
  w('2');
  w('CONTINUOUS');
  w('70');
  w('0');
  w('3');
  w('Solid line');
  w('72');
  w('65');
  w('73');
  w('0');
  w('40');
  w('0.0');
  w('0');
  w('ENDTAB');

  // LAYER table
  w('0');
  w('TABLE');
  w('2');
  w('LAYER');
  w('70');
  w(String(visibleSketches.length));
  for (const sketch of visibleSketches) {
    w('0');
    w('LAYER');
    w('2');
    w(sketch.name);
    w('70');
    w('0');
    w('62');
    w('7');
    w('6');
    w('CONTINUOUS');
  }
  w('0');
  w('ENDTAB');

  w('0');
  w('ENDSEC');

  // ENTITIES section
  w('0');
  w('SECTION');
  w('2');
  w('ENTITIES');

  for (const sketch of visibleSketches) {
    for (const entity of sketch.entities) {
      if ('construction' in entity && entity.construction) continue;
      if (entity.type === 'line') {
        const segCount = getSegmentCount(entity);
        for (let i = 0; i < segCount; i++) {
          const [i1, i2] = getSegmentPointIndices(entity, i);
          const p1 = entity.points[i1]!;
          const p2 = entity.points[i2]!;
          w('0');
          w('LINE');
          w('8');
          w(sketch.name);
          w('10');
          w(String(p1.x));
          w('20');
          w(String(p1.y));
          w('30');
          w('0.0');
          w('11');
          w(String(p2.x));
          w('21');
          w(String(p2.y));
          w('31');
          w('0.0');
        }
      } else if (entity.type === 'circle') {
        w('0');
        w('CIRCLE');
        w('8');
        w(sketch.name);
        w('10');
        w(String(entity.center.x));
        w('20');
        w(String(entity.center.y));
        w('30');
        w('0.0');
        w('40');
        w(String(entity.radius));
      } else if (entity.type === 'rectangle') {
        const hw = entity.width / 2;
        const hh = entity.height / 2;
        const cx = entity.center.x;
        const cy = entity.center.y;
        w('0');
        w('LWPOLYLINE');
        w('8');
        w(sketch.name);
        w('90');
        w('4');
        w('70');
        w('1');
        w('10');
        w(String(cx - hw));
        w('20');
        w(String(cy - hh));
        w('10');
        w(String(cx + hw));
        w('20');
        w(String(cy - hh));
        w('10');
        w(String(cx + hw));
        w('20');
        w(String(cy + hh));
        w('10');
        w(String(cx - hw));
        w('20');
        w(String(cy + hh));
      } else if (entity.type === 'point') {
        w('0');
        w('POINT');
        w('8');
        w(sketch.name);
        w('10');
        w(String(entity.position.x));
        w('20');
        w(String(entity.position.y));
        w('30');
        w('0.0');
      }
      // Dimensions are not exported (annotations, not geometry)
    }
  }

  w('0');
  w('ENDSEC');
  w('0');
  w('EOF');

  return lines.join('\n');
}
