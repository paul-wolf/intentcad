/**
 * Face-sketch dimensions that use the part's parameters: `floor + 2` for a
 * cutout's height above the floor. Before every build each face sketch the
 * script uses is re-solved with the script's P (and the document's own
 * parameters; P wins a clash), so the profile sent with the build — and the
 * build's cache key — follow P.
 */
import type { Sketch } from '@/types/document';
import { referencedSketchNames, sketchProfile, type SketchBindings } from './faceSketch';
import { partParams } from './scriptParams';
import { followRefs, outlineEntities } from './sketchRefs';
import { resolveSketch, sameGeometry, type ResolveWarning } from '@/utils/resolveSketch';

export interface PartSketches {
  /** the document's sketches, with the re-solved ones replaced (the same
   *  array when none changed) */
  sketches: Sketch[];
  /** names of the sketches whose geometry changed */
  changed: string[];
  warnings: ResolveWarning[];
  /** what the expressions were evaluated with */
  vars: Record<string, number>;
}

/** The variables a face-sketch dimension can use: the document's parameters
 *  and the part's P, P winning a clash. */
export function sketchVars(code: string, docParams?: Record<string, number> | null,
                           built?: Record<string, number> | null): Record<string, number> {
  return { ...(docParams ?? {}), ...partParams(code, built) };
}

/** Re-solve the face sketches `code` uses that have expression dimensions.
 *  Pure: nothing is stored; the caller stores `sketches` when `changed`. */
export function resolvePartSketches(code: string, sketches: Sketch[], docParams?: Record<string, number> | null,
                                    built?: Record<string, number> | null): PartSketches {
  const vars = sketchVars(code, docParams, built);
  const used = new Set(referencedSketchNames(code));
  const changed: string[] = [];
  const warnings: ResolveWarning[] = [];
  const out = sketches.map((s) => {
    if (!s.plane || !used.has(s.name) || !s.entities.some((e) => e.type === 'dimension' && e.expression)) return s;
    const r = resolveSketch(s, vars);
    warnings.push(...r.warnings);
    if (!r.changed) return s;
    changed.push(s.name);
    return r.sketch;
  });
  return { sketches: changed.length ? out : sketches, changed, warnings, vars };
}

/** "Sketch 'USB cutout': floor + 2 uses 'floor', which isn't a parameter; kept its last size" */
export function sketchParamWarning(w: ResolveWarning): string {
  const names = w.missing.map((n) => `'${n}'`).join(', ');
  const isnt = w.missing.length === 1 ? "which isn't a parameter" : "which aren't parameters";
  return `Sketch '${w.sketch}': ${w.expression} uses ${names}, ${isnt}; kept its last size`;
}

export interface FollowedSketches {
  /** the document's sketches, with the followed ones replaced (the same
   *  array when none changed) */
  sketches: Sketch[];
  /** names of the sketches that changed at all (a reference edge moved,
   *  broke, came back or was added) */
  changed: string[];
  /** …of those, the ones whose reference edges moved */
  moved: string[];
  /** …and the ones whose profile (what the build extrudes) changed */
  profileChanged: string[];
}

/** After a build: each face sketch's reference outline moved onto the edges
 *  of the face the build put it on (`bound`, the build's sketches), and its
 *  dimensions solved again — expression ones with `vars`. Pure: the caller
 *  stores `sketches` when `changed`. */
export function followPartSketches(sketches: Sketch[], bound: SketchBindings | null | undefined,
                                   vars?: Record<string, number> | null): FollowedSketches {
  const changed: string[] = [], moved: string[] = [], profileChanged: string[] = [];
  const out = sketches.map((s) => {
    const outline = s.face ? bound?.[s.name]?.outline : undefined;
    if (!outline?.length) return s;
    const r = followRefs(s, outlineEntities(outline), vars);
    if (!r.changed) return s;
    changed.push(s.name);
    if (r.moved) moved.push(s.name);
    if (!sameGeometry(sketchProfile(s), sketchProfile(r.sketch))) profileChanged.push(s.name);
    return r.sketch;
  });
  return { sketches: changed.length ? out : sketches, changed, moved, profileChanged };
}

/** A build that applies what it moved: `run` builds, `follow` moves the face
 *  sketches onto what it built and says whether that changed a profile the
 *  build used. If it did, build once more (with the new profiles) — never
 *  more: `unsettled` when the second build moved them again. */
export async function buildFollowingSketches<R>(run: () => Promise<R>, follow: (r: R) => boolean):
    Promise<{ result: R; rebuilt: boolean; unsettled: boolean }> {
  const first = await run();
  if (!follow(first)) return { result: first, rebuilt: false, unsettled: false };
  const second = await run();
  return { result: second, rebuilt: true, unsettled: follow(second) };
}
