import { useDocumentStore } from '@/stores/documentStore';
import { addLog } from '@/stores/logStore';
import { api } from './cachedClient';
import { sketchProfile } from '@/build/faceSketch';
import { withSharedProfiles } from '@/build/sharedSketch';
import type { Document, Sketch } from '@/types/document';
import { useProjectParamsStore } from '@/stores/projectParamsStore';
import { stampSolvedWith } from '@/build/projectSketchSolve';
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
 *  read it as SK["alias"] (build/sharedSketch.ts), and in a project the
 *  project values a dimension just given one by name was set with
 *  (build/projectSketchSolve.ts stampSolvedWith). */
function withProfiles(doc: Record<string, unknown>): Record<string, unknown> {
  if (!isSketchDoc(doc) || !Array.isArray(doc.sketches)) return doc;
  const pp = useProjectParamsStore.getState();
  if (projectId && pp.projectId === projectId) {
    doc = stampSolvedWith(doc as unknown as Document, pp.params) as unknown as Record<string, unknown>;
  }
  return { ...doc, sketches: withSharedProfiles(doc.sketches as Sketch[]) };
}

/** How a save went: saved, refused because the server has a newer version
 *  ('conflict'; `codeChanged` when it was the script), or not sent / failed. */
export type SaveOutcome = { saved: true } | { saved: false; conflict: boolean; codeChanged: boolean };
const NOT_SENT: SaveOutcome = { saved: false, conflict: false, codeChanged: false };

function doSave(id: string, doc: Record<string, unknown>, history?: unknown, versionLabel?: string, snapshot = false,
                codeBase?: string | null): Promise<SaveOutcome> {
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
    return Promise.resolve(NOT_SENT);
  }
  doc = withProfiles(doc);
  // a sketch save that would drop a group or name a part uses waits for the user
  if (isSketchDoc(doc) && !guardSave(id, doc.sketches as Sketch[], () => void send(id, doc, history, versionLabel, snapshot))) {
    return Promise.resolve(NOT_SENT);
  }
  return send(id, doc, history, versionLabel, snapshot, codeBase);
}

function send(id: string, doc: Record<string, unknown>, history?: unknown, versionLabel?: string, snapshot = false,
              codeBase?: string | null): Promise<SaveOutcome> {
  return api.updateDocument(id, {
    name: (doc as { name: string }).name,
    data: doc,
    history,
    version_label: versionLabel,
    snapshot,
  }, codeBase).then((saved): SaveOutcome => {
    addLog('info', 'Document saved');
    if (isSketchDoc(doc)) void refreshUsers(id);   // the parts using it may now be out of date
    else if (saved.data?.modelCode !== doc.modelCode) {
      // this save didn't change the script, and another tab or browser had: the server kept theirs
      addLog('info', 'This part\'s script was changed in another tab or browser; the server kept that version. Reload to see it.');
    }
    return { saved: true };
  }).catch((err: unknown): SaveOutcome => {
    if (err instanceof Error && (err as Error & { conflict?: boolean }).conflict) {
      const codeChanged = !!(err as Error & { codeChanged?: boolean }).codeChanged;
      // The server had a newer version (another tab saved). We did NOT overwrite it.
      // Our local edits are preserved in this tab's memory; the store still holds them.
      addLog('error',
        'This part was changed in another tab/session, so this save was refused to protect that newer work. Reload to see the latest — your unsaved changes here are still on screen.');
      console.warn('[autoSave] save refused: newer version exists on the server (conflict)');
      return { saved: false, conflict: true, codeChanged };
    } else if (err instanceof Error && (err as Error & { queued?: boolean }).queued) {
      addLog('info', 'Offline — changes saved locally, will sync when reconnected');
    } else {
      console.error('[autoSave] Save failed:', err);
      addLog('error', `Save failed: ${err}`);
    }
    return NOT_SENT;
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
export function persistModelCode(code: string, label?: string, snapshot = true, codeBase?: string | null): Promise<SaveOutcome> {
  useDocumentStore.getState().setModelCode(code, label);
  if (!backendId) return Promise.resolve(NOT_SENT);
  const state = useDocumentStore.getState();
  const doc = { ...state.document } as unknown as Record<string, unknown>;
  const history = { undo: state.undoStack, redo: state.redoStack };
  // `codeBase`: (an AI edit) the script version it started from, so it isn't
  // saved over one saved elsewhere since (see cachedClient's codeBase)
  return doSave(backendId, doc, history, label, snapshot, codeBase);
}

/** Save an AI edit's script, only over the saved version it started from
 *  (`codeBase`; null: over any, an overwrite the user chose). Refused (the
 *  part changed in another tab or browser), this tab's script stays as it was. */
export async function persistAiCode(code: string, codeBase: string | null | undefined): Promise<SaveOutcome> {
  const { modelCode, modelCodeLabel, modelCodeHistory } = useDocumentStore.getState().document;
  const out = await persistModelCode(code, undefined, false, codeBase);
  if (!out.saved && out.conflict) {
    useDocumentStore.setState((s) => ({ document: { ...s.document, modelCode, modelCodeLabel, modelCodeHistory } }));
  }
  return out;
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

/** Persist the parameters' slider ranges NOW (a part's P, a drawn sketch's own). */
export function persistParamRanges(ranges: Record<string, import('@/utils/paramRange').SavedRange>) {
  const st = useDocumentStore.getState();
  useDocumentStore.setState({ document: { ...st.document, paramRanges: ranges } });
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

/** Change the chat as it is now (not as some component last saw it) and persist it. */
export function updateChat(change: (chat: import('@/types/document').ChatMessage[]) => import('@/types/document').ChatMessage[]) {
  persistChat(change(useDocumentStore.getState().document.chat ?? []));
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

// A parameter slider is trying a value in a drawn sketch: the store shows it
// (re-solved live) but it isn't saved until Apply, so store changes don't
// schedule saves meanwhile. Explicit requestSave() calls still save.
let trialHold = false;
export function holdSavesForTrial(on: boolean) { trialHold = on; }

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
    if (trialHold) return;
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
