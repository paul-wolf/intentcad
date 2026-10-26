/**
 * Pasting project parameters: lines of "name value [unit]" (from notes, a
 * spreadsheet, an AI reply) read into parameters, and what saving them would
 * do to the project's list: new, changed or unchanged. Used by Paste on the
 * project's Parameters table and by the chat's parameter card.
 *
 * A line may use spaces, tabs, "=" or ":" between its parts ("prop_d = 406.4
 * mm", "tube_od: 30mm", "bolt M3"). Units are mm or deg (°, degrees); a number
 * with no unit keeps the unit an existing parameter of that name has, else it
 * is a count. Words after a number's unit are its description. Blank lines and
 * lines starting with # or // are skipped; ";" also separates entries.
 */
import type { ProjectParameter } from '@/types/project';

export interface PasteError { line: number; text: string; why: string }

/** A pasted parameter; `unit` null when the line gave none. */
export type PastedParameter = Omit<ProjectParameter, 'unit'> & { unit: ProjectParameter['unit'] | null };

export const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NUMBER = /^-?(\d+\.?\d*|\.\d+)$/;
const UNITS: Record<string, ProjectParameter['unit']> = { mm: 'mm', deg: 'deg', degree: 'deg', degrees: 'deg', '°': 'deg' };
// lengths and angles the project can't hold: an error, not a description
const OTHER_UNITS = new Set(['cm', 'm', 'in', 'inch', 'inches', '"', 'ft', 'um', 'µm', 'mil', 'rad', 'radians']);

export function parsePastedParameters(text: string): { items: PastedParameter[]; errors: PasteError[] } {
  const items: PastedParameter[] = [];
  const errors: PasteError[] = [];
  const seen = new Map<string, number>();
  text.split(/\r?\n/).forEach((raw, i) => {
    for (const part of raw.split(';')) {
      const s = part.trim();
      if (!s || s.startsWith('#') || s.startsWith('//')) continue;
      const fail = (why: string) => errors.push({ line: i + 1, text: s, why });
      const m = /^([^\s=:]+)\s*(?:[=:]\s*|\s+)(.*)$/.exec(s);
      if (!m) { fail('it has a name but no value'); continue; }
      const name = m[1]!;
      const rest = m[2]!.trim();
      if (!PARAM_NAME.test(name)) { fail(`"${name}" isn't a usable name: use letters, digits and _, not starting with a digit`); continue; }
      if (!rest) { fail('it has a name but no value'); continue; }
      const p = readValue(rest);
      if (typeof p === 'string') { fail(p); continue; }
      if (seen.has(name)) { fail(`"${name}" is also on line ${seen.get(name)}`); continue; }
      seen.set(name, i + 1);
      items.push({ name, ...p });
    }
  });
  return { items, errors };
}

/** "406.4 mm socket" → its value, unit and description; or why it can't be read. */
function readValue(rest: string): Omit<PastedParameter, 'name'> | string {
  // the number, then a unit glued on ("30mm", "45°") or after a space
  const m = /^(-?(?:\d+\.?\d*|\.\d+))(°|[A-Za-zµ"]+)?(?:\s+(.*))?$/.exec(rest);
  if (!m || !NUMBER.test(m[1]!)) return { value: rest, unit: '' };   // text, such as M3
  const value = Number(m[1]);
  let unitWord = m[2] ?? '';
  let tail = (m[3] ?? '').trim();
  if (!unitWord && tail) {
    const [w, ...more] = tail.split(/\s+/);
    if (w!.toLowerCase() in UNITS || OTHER_UNITS.has(w!.toLowerCase())) { unitWord = w!; tail = more.join(' '); }
  }
  const lower = unitWord.toLowerCase();
  if (unitWord && OTHER_UNITS.has(lower)) return `"${unitWord}" isn't a unit here: use mm or deg (or none for a count)`;
  if (unitWord && !(lower in UNITS)) {
    // glued text that isn't a unit ("12abc"): read the whole as text
    return { value: rest, unit: '' };
  }
  return { value, unit: unitWord ? UNITS[lower]! : null, ...(tail ? { description: tail } : {}) };
}

export type PreviewStatus = 'new' | 'changed' | 'unchanged';
export interface PreviewItem { item: ProjectParameter; status: PreviewStatus; was?: ProjectParameter }

/** Each pasted or proposed parameter against the project's list now: new,
 *  changed (value, unit or a given description) or unchanged. A pasted one
 *  with no unit takes the unit of the one it replaces (else a count). */
export function previewParameters(now: ProjectParameter[], items: (PastedParameter | ProjectParameter)[]): PreviewItem[] {
  return items.map((p) => {
    const was = now.find((x) => x.name === p.name);
    const unit = p.unit ?? (was && typeof p.value === 'number' && typeof was.value === 'number' ? was.unit : '');
    const item: ProjectParameter = { name: p.name, value: p.value, unit, ...(p.description ? { description: p.description } : {}) };
    if (!was) return { item, status: 'new' };
    const same = was.value === item.value && was.unit === item.unit && (!item.description || item.description === (was.description ?? ''));
    return { item, status: same ? 'unchanged' : 'changed', was };
  });
}

/** "2 new, 1 changed, 3 unchanged" */
export function previewWords(preview: PreviewItem[]): string {
  const n = (s: PreviewStatus) => preview.filter((p) => p.status === s).length;
  return (['new', 'changed', 'unchanged'] as const).filter((s) => n(s)).map((s) => `${n(s)} ${s}`).join(', ');
}
