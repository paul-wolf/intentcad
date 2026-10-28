/**
 * One sketch, one extrude: a face sketch reopened in the part editor and
 * extruded again updates the step that extrudes it already, instead of
 * adding a second one. Pure helpers for that.
 */
import type { Step } from '@/api/client';
import type { ExtrudeValues } from '@/components/OpDialogs';
import type { ExtrudeOptions } from '@/components/FaceSketchMode';

/** The step that extrudes sketch `name` (the last one, if several): switched
 *  off steps and linked mirror or pattern copies don't count. */
export function extrudeStepOf(steps: Step[], name: string): Step | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]!;
    if (s.kind === 'op' && s.op === 'extrude' && s.sketch === name && !s.off && s.mirror_of == null && s.pattern_of == null) return s;
  }
  return null;
}

/** An extrude line's values as the sketcher's Extrude panel shows them. */
export function sketcherOptions(v: ExtrudeValues): ExtrudeOptions {
  return { op: v.op, depth: v.depth, through: v.through, flip: v.flip, both: v.both, datum: v.datum, extent: v.extent };
}

/** The line's values after the sketcher's Extrude panel: what the panel set,
 *  on the line's sketch and face. The step that makes the part stays a New
 *  body, at a distance; a depth left empty keeps the line's. */
export function withSketcherOptions(v: ExtrudeValues, firstBody: boolean, ex: ExtrudeOptions): ExtrudeValues {
  return {
    ...v,
    op: firstBody ? 'new' : ex.op === 'new' ? v.op : ex.op,
    depth: ex.depth > 0 ? ex.depth : v.depth,
    through: !firstBody && !!ex.through, flip: ex.flip, both: !!ex.both,
    extent: firstBody ? 'distance' : ex.extent ?? (ex.through ? 'through' : 'distance'),
  };
}
