/**
 * Project parameters in project sketches. A sketch document in a project sizes
 * its dimensions with the project's parameters by name (`brace_t + 2`), as
 * well as with its own ("This sketch only"; its own win a clash, though the
 * server refuses to make one name both).
 *
 * Only the browser solves a sketch. Each sketch saves the project values it
 * was solved with (`solvedWith`); the server compares them with the project's
 * (backend shared_defs.sketch_state) and gives parts no shapes from a sketch
 * whose values have changed since ("pending"). Whoever finds one solves it:
 *   - the sketch editor, on open and when it comes back into focus;
 *   - the part editor, before a build (`solvePending`, from /build/inputs);
 *   - the project page and the AI's parameter card, right after a save
 *     (`solveProjectSketches`).
 * A value the sketch can't take saves `solveError` and keeps the sketch's
 * last good shapes and `solvedWith`; parts then build from those, with the
 * values those shapes were solved with ("failed", "held").
 */
import type { DimensionEntity, Document, Sketch } from '@/types/document';
import type { ProjectParameter } from '@/types/project';
import { api } from '@/api/cachedClient';
import { projectApi } from '@/api/projectClient';
import { expressionNames } from '@/utils/expression';
import { resolveSketch } from '@/utils/resolveSketch';
import { isSketchDocument } from '@/utils/document';
import { withSharedProfiles } from './sharedSketch';

export type ParamValue = number | string | null;

export interface SolveError {
  /** the project values it couldn't be solved with */
  with: Record<string, ParamValue>;
  message: string;
  dimensionIds: string[];
}

/** A project sketch the server says isn't solved for the project's values
 *  (backend shared_defs.resolve "unsolved"). */
export interface Unsolved {
  document: string;
  sketch: string;
  project: string | null;
  name: string;
  state: 'pending' | 'failed';
  names: string[];
  message: string;
  held: Record<string, ParamValue>;
}

type Solvable = Sketch;

/** The project's number parameters, as expression variables (text values
 *  like "M3" can't size a dimension). */
export function numericParams(params: ProjectParameter[] | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of params ?? []) if (typeof p.value === 'number' && isFinite(p.value)) out[p.name] = p.value;
  return out;
}

/** What a project sketch's dimensions can use: the project's numbers, then
 *  the document's own parameters (its own win a clash). */
export function projectSketchVars(params: ProjectParameter[] | null | undefined,
                                  own: Record<string, number> | null | undefined): Record<string, number> {
  return { ...numericParams(params), ...(own ?? {}) };
}

const exprDims = (s: Sketch) =>
  s.entities.filter((e): e is DimensionEntity => e.type === 'dimension' && !!e.expression);

/** The project parameters a sketch's dimensions use (not its own of the same
 *  name), with any it was solved with that the project has since deleted
 *  (backend shared_defs.sketch_pp). */
export function sketchProjectNames(sketch: Sketch, params: ProjectParameter[], own?: Record<string, number> | null): string[] {
  const known = new Set(params.map((p) => p.name));
  const solved = (sketch as Solvable).solvedWith ?? {};
  const names = new Set<string>();
  for (const d of exprDims(sketch)) for (const n of expressionNames(d.expression!)) {
    if (!(own && n in own) && (known.has(n) || n in solved)) names.add(n);
  }
  return [...names].sort();
}

const valueOf = (params: ProjectParameter[], n: string): ParamValue => params.find((p) => p.name === n)?.value ?? null;

/** Whether a sketch is solved for the project's current values. */
export function isSolvedFor(sketch: Sketch, params: ProjectParameter[], own?: Record<string, number> | null): boolean {
  const solved = (sketch as Solvable).solvedWith ?? {};
  return sketchProjectNames(sketch, params, own).every((n) => n in solved && solved[n] === valueOf(params, n));
}

export interface ProjectSolve {
  sketch: Sketch;
  /** anything about the sketch changed (geometry, solvedWith or solveError) */
  changed: boolean;
  error: SolveError | null;
}

/** A project sketch solved with the project's parameters and the document's
 *  own: the new geometry and `solvedWith`, or, when a value can't be met, the
 *  sketch as it was with `solveError`. A dimension counts against it when it
 *  uses a project parameter, or the sketch met it before (something else in
 *  the sketch pulled it off). Pure. */
export function solveWithProject(sketch: Sketch, params: ProjectParameter[], own?: Record<string, number> | null): ProjectSolve {
  const s = sketch as Solvable;
  const names = sketchProjectNames(sketch, params, own);
  if (!names.length) {
    if (!s.solvedWith && !s.solveError) return { sketch, changed: false, error: null };
    const { solvedWith: _w, solveError: _e, ...rest } = s;
    return { sketch: rest, changed: true, error: null };
  }
  const now: Record<string, ParamValue> = Object.fromEntries(names.map((n) => [n, valueOf(params, n)]));
  const project = new Set(names);
  const usesProject = (expr: string) => expressionNames(expr).some((n) => project.has(n));
  const r = resolveSketch(sketch, projectSketchVars(params, own));
  const messages: string[] = [];
  const ids: string[] = [];
  for (const w of r.warnings) {
    const gone = w.missing.filter((n) => project.has(n));
    if (!gone.length) continue;
    ids.push(w.dimensionId);
    messages.push(gone.map((n) => {
      const v = valueOf(params, n);
      return v === null ? `${w.expression} uses ${n}, which is no longer a project parameter`
        : `${w.expression} uses ${n}, which is text (${v}), not a number`;
    }).join('; '));
  }
  for (const f of r.failures) {
    if (!usesProject(f.expression) && !f.wasMet) continue;
    ids.push(f.dimensionId);
    messages.push(f.message);
  }
  if (messages.length) {
    const error: SolveError = { with: now, message: [...new Set(messages)].join('; '), dimensionIds: ids };
    const same = JSON.stringify(s.solveError ?? null) === JSON.stringify(error);
    return { sketch: same ? sketch : { ...s, solveError: error }, changed: !same, error };
  }
  const { solveError: _e, ...rest } = r.sketch as Solvable;
  const sameWith = JSON.stringify(s.solvedWith ?? null) === JSON.stringify(now);
  if (!r.changed && sameWith && !s.solveError) return { sketch, changed: false, error: null };
  return { sketch: { ...rest, solvedWith: now }, changed: true, error: null };
}

export interface DocumentSolve {
  document: Document;
  changed: boolean;
  /** the sketches that couldn't be solved: [sketch name, error] */
  failed: [string, SolveError][];
}

/** Every sketch of a sketch document solved with the project's parameters. */
export function solveDocument(doc: Document, params: ProjectParameter[]): DocumentSolve {
  let changed = false;
  const failed: [string, SolveError][] = [];
  const sketches = doc.sketches.map((s) => {
    const r = solveWithProject(s, params, doc.parameters);
    if (r.error) failed.push([s.name, r.error]);
    if (r.changed) changed = true;
    return r.sketch;
  });
  return { document: changed ? { ...doc, sketches } : doc, changed, failed };
}

/** The project values a sketch's newly used names were set with, when it
 *  has no solve error (a dimension just given `brace_t + 2` was set with the
 *  value it has now): saved with the sketch, so the server knows it is solved. */
export function stampSolvedWith(doc: Document, params: ProjectParameter[]): Document {
  let changed = false;
  const sketches = doc.sketches.map((s) => {
    const sk = s as Solvable;
    if (sk.solveError) return s;
    const solved = sk.solvedWith ?? {};
    const add = sketchProjectNames(s, params, doc.parameters).filter((n) => !(n in solved));
    const keep = Object.keys(solved).filter((n) => sketchProjectNames(s, params, doc.parameters).includes(n));
    if (!add.length && keep.length === Object.keys(solved).length) return s;
    changed = true;
    const next: Record<string, ParamValue> = Object.fromEntries(keep.map((n) => [n, solved[n]!]));
    for (const n of add) next[n] = valueOf(params, n);
    if (!Object.keys(next).length) {
      const { solvedWith: _w, ...rest } = sk;
      return rest;
    }
    return { ...sk, solvedWith: next };
  });
  return changed ? { ...doc, sketches } : doc;
}

/** Solve a saved sketch document with the project's parameters and save it
 *  if anything changed: 'saved', 'unchanged', or why it couldn't be. The
 *  failures are saved too (on the sketch, for everyone to see). */
export async function solveSavedSketch(id: string, params: ProjectParameter[]):
    Promise<{ status: 'saved' | 'unchanged'; failed: [string, SolveError][] } | { status: 'error'; message: string }> {
  try {
    const saved = await api.getDocument(id);
    const doc = saved.data as unknown as Document;
    if (!doc || !Array.isArray(doc.sketches) || !isSketchDocument(doc)) return { status: 'unchanged', failed: [] };
    const r = solveDocument(doc, params);
    if (!r.changed) return { status: 'unchanged', failed: r.failed };
    const data = { ...r.document, sketches: withSharedProfiles(r.document.sketches) };
    await api.updateDocument(id, { name: saved.name, data: data as unknown as Record<string, unknown> });
    return { status: 'saved', failed: r.failed };
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

/** Solve the pending sketches a build found (`unsolved` from /build/inputs),
 *  each document once, with its own project's parameters. `saved` when any
 *  was saved (the build should ask again). */
export async function solvePending(unsolved: Record<string, Unsolved> | null | undefined,
                                   params: (projectId: string) => Promise<ProjectParameter[]> = projectParameters):
    Promise<{ saved: boolean; errors: string[] }> {
  const pending = Object.values(unsolved ?? {}).filter((u) => u.state === 'pending' && u.project);
  const docs = new Map(pending.map((u) => [u.document, u.project!]));
  let saved = false;
  const errors: string[] = [];
  const byProject = new Map<string, ProjectParameter[]>();
  for (const [id, pid] of docs) {
    try {
      if (!byProject.has(pid)) byProject.set(pid, await params(pid));
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      continue;
    }
    const r = await solveSavedSketch(id, byProject.get(pid)!);
    if (r.status === 'saved') saved = true;
    if (r.status === 'error') errors.push(r.message);
  }
  return { saved, errors };
}

const projectParameters = (projectId: string) => projectApi.getProject(projectId).then((p) => p.parameters ?? []);

/** After the project's parameters were saved: solve every sketch document of
 *  the project that uses them (but `skip`, the one open in this editor, which
 *  solves itself). The sketches that couldn't be solved, by name. */
export async function solveProjectSketches(projectId: string, params: ProjectParameter[], skip?: string | null):
    Promise<{ saved: string[]; failed: string[]; errors: string[] }> {
  const out = { saved: [] as string[], failed: [] as string[], errors: [] as string[] };
  const list = await api.listDocuments(projectId);
  for (const d of list) {
    if ((d.kind && d.kind !== 'sketch') || d.id === skip) continue;
    const r = await solveSavedSketch(d.id, params);
    if (r.status === 'error') out.errors.push(`${d.name}: ${r.message}`);
    else {
      if (r.status === 'saved') out.saved.push(d.name);
      for (const [name, e] of r.failed) out.failed.push(`${d.name}${name !== d.name ? ` · ${name}` : ''}: ${e.message}`);
    }
  }
  return out;
}

/** Save the project's parameters (with `renames`, {old: new}) and solve its
 *  sketches with them, so parts never wait for one: the saved list, and
 *  what solving said. Throws what the server refused. */
export async function saveProjectParameters(projectId: string, params: ProjectParameter[],
                                            renames: Record<string, string> = {}, skip?: string | null) {
  const saved = await projectApi.setParameters(projectId, params, renames);
  const list = saved.parameters ?? params;
  const solved = await solveProjectSketches(projectId, list, skip);
  return { project: saved, params: list, ...solved };
}

/** What solving after a save said, for the log ('' when all went well). */
export function solvedWords(r: { failed: string[]; errors: string[] }): string {
  return [...r.failed.map((f) => `can't be solved: ${f}`), ...r.errors.map((e) => `couldn't be solved: ${e}`)].join('; ');
}

/** Unit mismatches in a sketch: a degree parameter in a length dimension, or
 *  a mm parameter in an angle. Count and text parameters (unit "") are fine. */
export function unitWarnings(sketch: Sketch, params: ProjectParameter[], own?: Record<string, number> | null):
    { dimensionId: string; name: string; message: string }[] {
  const unit = new Map(params.map((p) => [p.name, p.unit]));
  const out: { dimensionId: string; name: string; message: string }[] = [];
  for (const d of exprDims(sketch)) {
    for (const n of expressionNames(d.expression!)) {
      if (own && n in own) continue;
      const u = unit.get(n);
      const msg = unitMismatch(n, u, !!d.angleMode);
      if (msg) out.push({ dimensionId: d.id, name: n, message: msg });
    }
  }
  return out;
}

/** "brace_angle is in degrees, but this is a length" (or null). */
export function unitMismatch(name: string, unit: string | undefined, angle: boolean): string | null {
  if (unit === 'deg' && !angle) return `${name} is in degrees, but this dimension is a length`;
  if (unit === 'mm' && angle) return `${name} is in mm, but this dimension is an angle`;
  return null;
}
