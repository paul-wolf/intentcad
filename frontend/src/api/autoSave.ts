import { useDocumentStore } from '@/stores/documentStore';
import { addLog } from '@/stores/logStore';
import { api } from './cachedClient';
import { sketchProfile } from '@/build/faceSketch';
import { withSharedProfiles } from '@/build/sharedSketch';
import type { Sketch } from '@/types/document';
import { guardSave, refreshUsers } from './sharedUses';

let timer: ReturnType<typeof setTimeout> | null = null;
let backendId: string | null = null;
let projectId: string | null = null;
let projectName: string | null = null;
let pendingId: string | null = null;
let pendingDoc: Record<string, unknown> | null = null;
let pendingHistory: unknown = null;

const DEBOUNCE_MS = 1500;

export function getBackendId() {
  return backendId;
}

export function setBackendId(id: string | null) {
  // Discard any pending save — the store may already hold a different document
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  pendingId = null;
  pendingDoc = null;
  pendingHistory = null;
  backendId = id;
  sawModelCode = false;   // new document context — re-arm the blank-save guard
  backendListeners.forEach((fn) => fn());
}

const backendListeners = new Set<() => void>();

/** Called when the open document changes (for useSyncExternalStore). */
export function subscribeBackendId(fn: () => void) {
  backendListeners.add(fn);
  return () => { backendListeners.delete(fn); };
}

export function getProjectId() {
  return projectId;
}

export function getProjectName() {
  return projectName;
}

const projectListeners = new Set<() => void>();

export function setProjectContext(id: string | null, name: string | null) {
  projectId = id;
  projectName = name;
  projectListeners.forEach((fn) => fn());
}

/** Called when the project context changes (for useSyncExternalStore). */
export function subscribeProjectContext(fn: () => void) {
  projectListeners.add(fn);
  return () => { projectListeners.delete(fn); };
}

// Guard against a blank/reset store clobbering a loaded document. Once a doc has
// shown model code this session, a save that lacks it is almost certainly a
// reset artifact (e.g. HMR resetting the store) — refuse it. 2D-only docs never
// set this flag, so their saves are unaffected.
let sawModelCode = false;
function hasModelCode(doc: Record<string, unknown>): boolean {
  const c = (doc as { modelCode?: unknown }).modelCode;
  return typeof c === 'string' && c.trim().length > 0;
}

const isSketchDoc = (doc: Record<string, unknown>) =>
  doc.type === 'sketch' || (doc.type !== 'part' && !hasModelCode(doc));

/** A sketch document saves each sketch's shared profile, for the parts that
 *  read it as SK["alias"] (build/sharedSketch.ts). */
function withProfiles(doc: Record<string, unknown>): Record<string, unknown> {
  if (!isSketchDoc(doc) || !Array.isArray(doc.sketches)) return doc;
  return { ...doc, sketches: withSharedProfiles(doc.sketches as Sketch[]) };
}

function doSave(id: string, doc: Record<string, unknown>, history?: unknown, versionLabel?: string, snapshot = false) {
  // A save supersedes an older debounced snapshot of the same doc — e.g. one
  // queued while a script-less part was sketched, before New body wrote its code
  if (pendingId === id) {
    if (timer) clearTimeout(timer);
    timer = null;
    pendingId = null;
    pendingDoc = null;
    pendingHistory = null;
  }
  if (hasModelCode(doc)) {
    sawModelCode = true;
  } else if (sawModelCode) {
    addLog('error', 'Blocked a save that would blank the model (store reset?). Reload to recover.');
    console.warn('[autoSave] blocked a blank-model save over a document that had model code');
    return;
  }
  doc = withProfiles(doc);
  // a sketch save that would drop a group or name a part uses waits for the user
  if (isSketchDoc(doc) && !guardSave(id, doc.sketches as Sketch[], () => send(id, doc, history, versionLabel, snapshot))) return;
  send(id, doc, history, versionLabel, snapshot);
}

function send(id: string, doc: Record<string, unknown>, history?: unknown, versionLabel?: string, snapshot = false) {
  api.updateDocument(id, {
    name: (doc as { name: string }).name,
    data: doc,
    history,
    version_label: versionLabel,
    snapshot,
  }).then(() => {
    addLog('info', 'Document saved');
    if (isSketchDoc(doc)) void refreshUsers(id);   // the parts using it may now be out of date
  }).catch((err: unknown) => {
    if (err instanceof Error && (err as Error & { conflict?: boolean }).conflict) {
      // The server had a newer version (another tab saved). We did NOT overwrite it.
      // Our local edits are preserved in this tab's memory; the store still holds them.
      addLog('error',
        'This part was changed in another tab/session, so this save was refused to protect that newer work. Reload to see the latest — your unsaved changes here are still on screen.');
      console.warn('[autoSave] save refused: newer version exists on the server (conflict)');
    } else if (err instanceof Error && (err as Error & { queued?: boolean }).queued) {
      addLog('info', 'Offline — changes saved locally, will sync when reconnected');
    } else {
      console.error('[autoSave] Save failed:', err);
      addLog('error', `Save failed: ${err}`);
    }
  });
}

/** Persist the build feature tree NOW (no debounce), directly — used by the 3D
 * panel so a tree edit is saved immediately rather than through the shared
 * debounce buffer (which effect ordering / fast refresh could drop). */
export function persistBuildFeatures(features: unknown[]) {
  // keep the in-memory document in sync, then save it directly (no debounce)
  useDocumentStore.getState().setBuildFeatures(features as never);
  if (!backendId) return;
  const state = useDocumentStore.getState();
  // face sketches carry their closed shapes, for scripts that extrude them
  const sketches = state.document.sketches.map((s) => (s.plane ? { ...s, profile: sketchProfile(s) ?? undefined } : s));
  const doc = { ...state.document, sketches } as unknown as Record<string, unknown>;
  const history = { undo: state.undoStack, redo: state.redoStack };
  doSave(backendId, doc, history);
}

/** Persist the build123d model script NOW (no debounce), directly. `label`
 *  describes what produced this version (for the version history). */
/** Persist the build123d model script NOW, directly.
 *  `snapshot` records an immutable version (true = a build-verified snapshot;
 *  false = an in-progress draft between builds — persisted but not versioned). */
export function persistModelCode(code: string, label?: string, snapshot = true) {
  useDocumentStore.getState().setModelCode(code, label);
  if (!backendId) return;
  const state = useDocumentStore.getState();
  const doc = { ...state.document } as unknown as Record<string, unknown>;
  const history = { undo: state.undoStack, redo: state.redoStack };
  doSave(backendId, doc, history, label, snapshot);
}

/** Persist a part's shared sketch aliases and pinned inputs NOW (with its
 *  script, when restoring a version: one save, one version). */
export function persistSharedRefs(sketchRefs: Record<string, import('@/types/document').SketchRef>,
                                  pinned: import('@/types/document').BuildInputs | null, code?: string) {
  const store = useDocumentStore.getState();
  store.setSharedRefs(sketchRefs, pinned);
  if (code !== undefined) store.setModelCode(code);
  if (!backendId) return;
  const state = useDocumentStore.getState();
  const doc = { ...state.document } as unknown as Record<string, unknown>;
  const history = { undo: state.undoStack, redo: state.redoStack };
  doSave(backendId, doc, history, undefined, false);
}

/** Persist a document rename NOW, directly (used by the part editor header). */
export function persistName(name: string) {
  useDocumentStore.getState().setDocumentName(name);
  if (!backendId) return;
  const state = useDocumentStore.getState();
  // face sketches carry their closed shapes, for scripts that extrude them
  const sketches = state.document.sketches.map((s) => (s.plane ? { ...s, profile: sketchProfile(s) ?? undefined } : s));
  const doc = { ...state.document, sketches } as unknown as Record<string, unknown>;
  const history = { undo: state.undoStack, redo: state.redoStack };
  doSave(backendId, doc, history);
}

/** Persist the part's target-production brief NOW, directly. */
export function persistProductionNotes(notes: string) {
  useDocumentStore.getState().setProductionNotes(notes);
  if (!backendId) return;
  const state = useDocumentStore.getState();
  // face sketches carry their closed shapes, for scripts that extrude them
  const sketches = state.document.sketches.map((s) => (s.plane ? { ...s, profile: sketchProfile(s) ?? undefined } : s));
  const doc = { ...state.document, sketches } as unknown as Record<string, unknown>;
  const history = { undo: state.undoStack, redo: state.redoStack };
  doSave(backendId, doc, history);
}

/** Persist the print bed face NOW (no debounce), with the rest of the document. */
export function persistPrintBed(bed: import('./client').FaceRefSpec | null) {
  useDocumentStore.getState().setPrintBed(bed);
  if (!backendId) return;
  const state = useDocumentStore.getState();
  const sketches = state.document.sketches.map((s) => (s.plane ? { ...s, profile: sketchProfile(s) ?? undefined } : s));
  const doc = { ...state.document, sketches } as unknown as Record<string, unknown>;
  const history = { undo: state.undoStack, redo: state.redoStack };
  doSave(backendId, doc, history);
}

/** Persist the AI modeling conversation NOW (no debounce), directly. */
export function persistChat(chat: import('@/types/document').ChatMessage[]) {
  useDocumentStore.getState().setChat(chat);
  if (!backendId) return;
  const state = useDocumentStore.getState();
  // face sketches carry their closed shapes, for scripts that extrude them
  const sketches = state.document.sketches.map((s) => (s.plane ? { ...s, profile: sketchProfile(s) ?? undefined } : s));
  const doc = { ...state.document, sketches } as unknown as Record<string, unknown>;
  const history = { undo: state.undoStack, redo: state.redoStack };
  doSave(backendId, doc, history);
}

/** Persist the part thumbnail (a PNG data URL) NOW, directly. */
export function persistThumbnail(dataUrl: string) {
  useDocumentStore.getState().setThumbnail(dataUrl);
  if (!backendId) return;
  const state = useDocumentStore.getState();
  // face sketches carry their closed shapes, for scripts that extrude them
  const sketches = state.document.sketches.map((s) => (s.plane ? { ...s, profile: sketchProfile(s) ?? undefined } : s));
  const doc = { ...state.document, sketches } as unknown as Record<string, unknown>;
  const history = { undo: state.undoStack, redo: state.redoStack };
  doSave(backendId, doc, history);
}

/** Schedule a debounced save of the current document state. */
export function requestSave() {
  const state = useDocumentStore.getState();
  const doc = state.document;
  const history = { undo: state.undoStack, redo: state.redoStack };
  scheduleSave(doc as unknown as Record<string, unknown>, history);
}

/** Immediately persist any pending debounced save. */
export function flushSave() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (pendingId && pendingDoc) {
    doSave(pendingId, pendingDoc, pendingHistory ?? undefined);
    pendingId = null;
    pendingDoc = null;
    pendingHistory = null;
  }
}

/** Flush any pending save and return a promise that resolves when it completes. */
export async function flushSaveAsync(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (pendingId && pendingDoc) {
    const id = pendingId;
    const doc = pendingDoc;
    const history = pendingHistory;
    pendingId = null;
    pendingDoc = null;
    pendingHistory = null;
    if (hasModelCode(doc)) sawModelCode = true;
    else if (sawModelCode) {
      console.warn('[autoSave] blocked a blank-model flush over a document that had model code');
      return;
    }
    const data = withProfiles(doc);
    if (isSketchDoc(data) && !guardSave(id, data.sketches as Sketch[], () => send(id, data, history ?? undefined))) return;
    await api.updateDocument(id, {
      name: (doc as { name: string }).name,
      data,
      history: history ?? undefined,
    });
  }
}

function scheduleSave(doc: Record<string, unknown>, history?: unknown) {
  if (!backendId) return;
  pendingId = backendId;
  pendingDoc = doc;
  pendingHistory = history ?? null;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    if (pendingId && pendingDoc) {
      doSave(pendingId, pendingDoc, pendingHistory ?? undefined);
      pendingId = null;
      pendingDoc = null;
      pendingHistory = null;
    }
  }, DEBOUNCE_MS);
}

export function startAutoSave() {
  // Deliberately NO save-on-mount and NO periodic/timer writer here.
  //
  // A part (the build123d model script) is persisted ONLY at explicit version
  // boundaries — an AI edit (persistModelCode), a chat turn (persistChat), or a
  // fresh build thumbnail (persistThumbnail). Nothing writes a part on a timer,
  // so an idle or stale tab can never quietly overwrite newer work.
  //
  // The legacy 2D sketch editor still coalesces its own explicit requestSave()
  // calls (user drawing actions) through the debounce below; those docs have no
  // modelCode, so the subscription skips parts entirely.
  const handleBeforeUnload = () => flushSave();
  window.addEventListener('beforeunload', handleBeforeUnload);

  const unsub = useDocumentStore.subscribe((state) => {
    if (!backendId) return;
    // Parts never auto-save from store changes — only via explicit persist* calls.
    if (hasModelCode(state.document as unknown as Record<string, unknown>)) return;
    const history = { undo: state.undoStack, redo: state.redoStack };
    scheduleSave(state.document as unknown as Record<string, unknown>, history);
  });

  return () => {
    unsub();
    window.removeEventListener('beforeunload', handleBeforeUnload);
    flushSave();
  };
}

/** Persist the document as it stands NOW (parts don't autosave from store
 *  changes; face sketches are saved explicitly while and after editing). */
export function persistSketches() {
  if (!backendId) return;
  const state = useDocumentStore.getState();
  // face sketches carry their closed shapes, for scripts that extrude them
  const sketches = state.document.sketches.map((s) => (s.plane ? { ...s, profile: sketchProfile(s) ?? undefined } : s));
  const doc = { ...state.document, sketches } as unknown as Record<string, unknown>;
  const history = { undo: state.undoStack, redo: state.redoStack };
  doSave(backendId, doc, history);
}
