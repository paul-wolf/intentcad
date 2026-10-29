/**
 * The steps list (Operations layout): the script's operations in order, as
 * backend paramedit.steps reads them. Pure helpers: which icon a step shows,
 * which step a script line belongs to, and which build problems belong to
 * which step.
 */
import type { RunResponse, Step } from '@/api/client';
import type { OpIcon } from './operations';

const ICONS: Record<string, OpIcon> = {
  extrude: 'extrude', revolve: 'revolve', shell: 'shell', holes: 'hole', fillet: 'fillet', chamfer: 'chamfer',
  auto_round: 'round', truss_windows: 'lighten', offset_plane: 'plane-offset', edge_plane: 'plane-edge', tangent_plane: 'plane-tangent',
  mirror_body: 'mirror', pattern_body: 'pattern',
};

/** The registry icon of a step's operation (none for a run of script); a
 *  linked mirrored copy shows the mirror, a pattern copy the pattern. */
export function stepIcon(s: Step): OpIcon | null {
  if (s.kind === 'op' && s.mirror_of != null) return 'mirror';
  if (s.kind === 'op' && s.pattern_of != null) return / round /.test(s.pattern ?? '') ? 'pattern-circular' : 'pattern';
  return s.kind === 'op' && s.op ? ICONS[s.op] ?? null : null;
}

/** What the row says. */
export function stepLabel(s: Step): string {
  if (s.kind === 'script') return `… script (${s.count} line${s.count === 1 ? '' : 's'})`;
  return s.summary ?? s.op ?? 'Step';
}

/** The step a script line is part of. */
export function stepAt(steps: Step[], line: number): Step | null {
  return steps.find((s) => line >= s.line && line <= s.end_line) ?? null;
}

/** The step on `line`, when its dialog can reopen it. */
export function reopenableAt(steps: Step[], line: number): Step | null {
  const s = stepAt(steps, line);
  return s && s.kind === 'op' && s.reopenable && !s.off ? s : null;
}

/** The script line a build message names ("line N: <source>\n…"). */
export function messageLine(message: string): number | null {
  const m = /^line (\d+):/.exec(message);
  return m ? Number(m[1]) : null;
}

/** The switched-off operations before `line`: what a failure there may be missing. */
export function offBefore(steps: Step[], line: number): Step[] {
  return steps.filter((s) => s.kind === 'op' && s.off && s.op !== 'script' && s.end_line < line);
}

/** A failure on `line` after a switched-off step, in words (null: none is off before it). */
export function suppressedNote(steps: Step[], line: number | null): string | null {
  if (line == null) return null;
  const off = offBefore(steps, line);
  if (!off.length) return null;
  const names = off.map((s) => `“${stepLabel(s)}” (line ${s.line})`);
  return off.length === 1
    ? `Step ${names[0]} is switched off: line ${line} may need what it makes. Switch it back on in the steps list.`
    : `Steps ${names.join(', ')} are switched off: line ${line} may need what they make. Switch them back on in the steps list.`;
}

/** The last line of a build message: what went wrong, without where. */
function gist(message: string): string {
  const rows = message.split('\n').map((l) => l.trim()).filter(Boolean);
  const row = rows.find((r, i) => i > 0 || !/^line \d+:/.test(r)) ?? rows[0] ?? message;
  // a sketch's own words need no type in front ("Sketch 'X' lost its face …")
  return row.replace(/^SketchError: /, '');
}

/** The build's problems, each on the step that caused it: the failing line
 *  (`failure`: the warning of a build shown up to it, or the error of one that
 *  failed), face and edge refs not found or ambiguous, and organic warnings.
 *  Keyed by the step's first line. */
export function stepProblems(steps: Step[], res: RunResponse | null, failure: string): Map<number, string[]> {
  const out = new Map<number, string[]>();
  const put = (line: number | null | undefined, text: string) => {
    if (line == null) return;
    const s = stepAt(steps, line);
    if (!s) return;
    const list = out.get(s.line) ?? [];
    if (!list.includes(text)) list.push(text);
    out.set(s.line, list);
  };
  if (failure) {
    const line = messageLine(failure);
    put(line, `Failed: ${gist(failure)}`);
    const note = suppressedNote(steps, line);
    if (note) put(line, note);
  }
  for (const r of res?.face_refs ?? []) {
    if (r.status === 'not_found') put(r.line, `The ${r.hint} wasn't found: reopen the step and pick the face again`);
    else if (r.status === 'ambiguous') put(r.line, `The ${r.hint}: not certain, the nearest face was used`);
  }
  for (const r of res?.edge_refs ?? []) {
    if (r.status === 'not_found') put(r.line, `The ${r.hint} wasn't found: reopen the step and pick the edge again`);
    else if (r.status === 'ambiguous') put(r.line, `The ${r.hint}: not certain, the nearest edge was used`);
  }
  for (const [name, p] of Object.entries(res?.planes ?? {})) {
    if (p.status === 'ambiguous') put(p.line, `Plane '${name}': its face or edge is not certain, the nearest was used`);
  }
  for (const w of res?.organic?.warnings ?? []) put(w.line, w.message);
  return out;
}

/** The sketch names on a base plane, and each sketch's hole points: what
 *  /build/steps and /build/op_at need to read the script as the editor wrote it. */
export function stepInputs(sketches: { name: string; basePlane: boolean; points: number; normal?: number[] | null }[]):
  { datum: string[]; points: Record<string, number>; normals: Record<string, number[]> } {
  return {
    datum: sketches.filter((s) => s.basePlane).map((s) => s.name),
    points: Object.fromEntries(sketches.filter((s) => s.points > 0).map((s) => [s.name, s.points])),
    // an extrude's step names the axis it goes along
    normals: Object.fromEntries(sketches.filter((s) => s.normal).map((s) => [s.name, s.normal!.map((x) => Math.round(x * 1e4) / 1e4)])),
  };
}
