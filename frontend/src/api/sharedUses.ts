/**
 * The open sketch document's users: the parts that read its sketches as
 * SK["alias"], and the groups and named elements their scripts ask for.
 *
 * A save that would drop one of those (a group renamed or deleted, a named
 * element gone) is held, and the sketch editor shows which parts it would
 * break, with Save anyway / Undo (SharedUsesBanner).
 */
import type { Sketch } from '@/types/document';
import { missingUses } from '@/build/sharedSketch';
import { api, type UsedByPart } from './client';

export interface Breakage {
  part: string;
  missing: string[];
}

let docId: string | null = null;
let parts: UsedByPart[] = [];
let held: { breaks: Breakage[]; save: () => void } | null = null;
let accepted = '';   // the breakages "Save anyway" accepted, so the next save isn't held again
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

export function subscribeSharedUses(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export const getUsers = () => parts;
export const getHeld = () => held;

/** Load the parts that use sketch document `id` (null: none open). */
export async function loadUsers(id: string | null): Promise<void> {
  docId = id;
  parts = [];
  held = null;
  accepted = '';
  notify();
  if (!id) return;
  try {
    const r = await api.usedBy(id);
    if (docId === id) { parts = r.parts; notify(); }
  } catch { /* a document with no project, or offline: nothing to guard */ }
}

/** Fetch the users again (after a save or a rebuild), keeping a held save. */
export async function refreshUsers(id: string): Promise<void> {
  if (id !== docId) return;
  try {
    const r = await api.usedBy(id);
    if (docId === id) { parts = r.parts; notify(); }
  } catch { /* keep what we had */ }
}

/** What saving these sketches would break: each part, and the groups and
 *  names it asks for that would be gone. */
export function breakages(sketches: Sketch[]): Breakage[] {
  const out: Breakage[] = [];
  for (const p of parts) {
    const missing = new Set<string>();
    for (const u of p.uses) {
      if (!u.in_script) continue;
      const s = sketches.find((k) => k.id === u.sketch);
      // a deleted sketch: the part loses all of it
      const gone = s ? missingUses(s, u) : [`sketch (deleted) for SK["${u.alias}"]`];
      gone.forEach((g) => missing.add(g));
    }
    if (missing.size) out.push({ part: p.name, missing: [...missing] });
  }
  return out;
}

/** Called by autoSave before saving sketch document `id`: true to save now,
 *  false when the save is held until the user decides (`save` then runs it). */
export function guardSave(id: string, sketches: Sketch[], save: () => void): boolean {
  if (id !== docId || !parts.length) return true;
  const breaks = breakages(sketches);
  const key = JSON.stringify(breaks);
  if (!breaks.length || key === accepted) {
    if (held) { held = null; notify(); }
    return true;
  }
  held = { breaks, save };
  notify();
  return false;
}

/** Save anyway: run the held save, and don't hold again for the same breakages. */
export function saveAnyway() {
  if (!held) return;
  const { breaks, save } = held;
  accepted = JSON.stringify(breaks);
  held = null;
  notify();
  save();
}

/** The held save is dropped (the user undid the change; the next save is checked again). */
export function dropHeld() {
  if (!held) return;
  held = null;
  notify();
}
