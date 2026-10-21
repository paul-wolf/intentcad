/**
 * Renumbering what refers to a shape's points and segments after an edit
 * changed them (a fillet, a trim): constraints and dimensions keep their
 * targets where those survive, and are dropped where they don't.
 */
import type { Constraint, Entity } from '@/types/document';

/** A new index for an old one, or null when that point or segment is gone. */
export type IndexMap = (i: number) => number | null;

export interface Remap {
  entityId: string;
  point: IndexMap;
  segment: IndexMap;
  /** the shape the references now go to (default: the same one) */
  newEntityId?: string;
}

type Slot = [entityKey: string, indexKey: string, kind: 'point' | 'segment'];

/** Where each constraint type names a shape and which of its points or segments. */
const SLOTS: Record<Constraint['type'], Slot[]> = {
  fixed: [],
  equal: [['entityId', 'segmentIndex', 'segment'], ['targetEntityId', 'targetSegmentIndex', 'segment']],
  coincident: [['entityId', 'pointIndex', 'point'], ['targetEntityId', 'targetPointIndex', 'point']],
  horizontalPoints: [['entityId', 'pointIndex', 'point'], ['targetEntityId', 'targetPointIndex', 'point']],
  verticalPoints: [['entityId', 'pointIndex', 'point'], ['targetEntityId', 'targetPointIndex', 'point']],
  midpoint: [['entityId', 'pointIndex', 'point'], ['targetEntityId', 'segmentIndex', 'segment']],
  pointOnCurve: [['entityId', 'pointIndex', 'point'], ['targetEntityId', 'segmentIndex', 'segment']],
  symmetric: [['entityId', 'pointIndex', 'point'], ['entityId2', 'pointIndex2', 'point'], ['targetEntityId', 'segmentIndex', 'segment']],
  horizontal: [['entityId', 'segmentIndex', 'segment']],
  vertical: [['entityId', 'segmentIndex', 'segment']],
  parallel: [['entityId', 'segmentIndex', 'segment'], ['targetEntityId', 'targetSegmentIndex', 'segment']],
  perpendicular: [['entityId', 'segmentIndex', 'segment'], ['targetEntityId', 'targetSegmentIndex', 'segment']],
  tangent: [['entityId', 'segmentIndex', 'segment'], ['targetEntityId', 'targetSegmentIndex', 'segment']],
  bisect: [['entityId', 'segmentIndex', 'segment'], ['targetEntityId', 'targetSegmentIndex', 'segment']],
};

/** A dimension's slots: its first target by point or segment, its second
 *  (a point on the same shape when only pointIndex2 is given). */
function dimensionSlots(d: Record<string, unknown>): Slot[] {
  const slots: Slot[] = [['targetEntityId', d.pointIndex != null ? 'pointIndex' : 'segmentIndex', d.pointIndex != null ? 'point' : 'segment']];
  if (d.targetEntityId2 != null) {
    slots.push(['targetEntityId2', d.pointIndex2 != null ? 'pointIndex2' : 'segmentIndex2', d.pointIndex2 != null ? 'point' : 'segment']);
  } else if (d.pointIndex2 != null) {
    slots.push(['targetEntityId', 'pointIndex2', 'point']);
  }
  return slots;
}

/** `obj` with its slots on `remap.entityId` renumbered; null when one is gone. */
function remapSlots<T extends object>(obj: T, slots: Slot[], remap: Remap): T | null {
  const src = obj as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  for (const [ek, ik, kind] of slots) {
    if (src[ek] !== remap.entityId) continue;
    const old = src[ik];
    if (typeof old !== 'number') continue; // an optional index left out: the whole shape
    const idx = (kind === 'point' ? remap.point : remap.segment)(old);
    if (idx == null) return null;
    out ??= { ...src };
    out[ik] = idx;
  }
  if (remap.newEntityId) {
    for (const [ek] of slots) {
      if (src[ek] === remap.entityId) {
        out ??= { ...src };
        out[ek] = remap.newEntityId;
      }
    }
  }
  return (out ?? obj) as T;
}

/** The sketch's constraints and dimensions with references to `remap.entityId`
 *  renumbered; those on a point or segment that's gone are dropped and
 *  counted. `keep` can drop more (e.g. a length on a segment now shorter). */
export function remapRefs(
  entities: Entity[],
  constraints: Constraint[],
  remap: Remap,
  keep: (x: Constraint | Entity) => boolean = () => true,
): { entities: Entity[]; constraints: Constraint[]; dropped: number } {
  let dropped = 0;
  const outC: Constraint[] = [];
  for (const c of constraints) {
    const r = remapSlots(c, SLOTS[c.type], remap);
    if (r && keep(c)) outC.push(r);
    else dropped++;
  }
  const outE: Entity[] = [];
  for (const e of entities) {
    if (e.type !== 'dimension') { outE.push(e); continue; }
    const r = remapSlots(e, dimensionSlots(e as unknown as Record<string, unknown>), remap);
    if (r && keep(e)) outE.push(r);
    else dropped++;
  }
  return { entities: outE, constraints: outC, dropped };
}
