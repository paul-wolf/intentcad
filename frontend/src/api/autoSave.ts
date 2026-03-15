import { useDocumentStore } from '@/stores/documentStore';
import { addLog } from '@/stores/logStore';
import { api } from './client';

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
}

export function getProjectId() {
  return projectId;
}

export function getProjectName() {
  return projectName;
}

export function setProjectContext(id: string | null, name: string | null) {
  projectId = id;
  projectName = name;
}

function doSave(id: string, doc: Record<string, unknown>, history?: unknown) {
  api.updateDocument(id, {
    name: (doc as { name: string }).name,
    data: doc,
    history,
  }).then(() => {
    addLog('info', 'Document saved');
  }).catch((err) => {
    console.error('[autoSave] PUT failed:', err);
    addLog('error', `Save failed: ${err}`);
  });
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
    await api.updateDocument(id, {
      name: (doc as { name: string }).name,
      data: doc,
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
  // Fire once immediately for the current state (covers migration on load)
  const current = useDocumentStore.getState();
  if (backendId) {
    const history = { undo: current.undoStack, redo: current.redoStack };
    scheduleSave(current.document as unknown as Record<string, unknown>, history);
  }

  const handleBeforeUnload = () => flushSave();
  window.addEventListener('beforeunload', handleBeforeUnload);

  const unsub = useDocumentStore.subscribe((state) => {
    if (!backendId) return;
    const history = { undo: state.undoStack, redo: state.redoStack };
    scheduleSave(state.document as unknown as Record<string, unknown>, history);
  });

  return () => {
    unsub();
    window.removeEventListener('beforeunload', handleBeforeUnload);
    flushSave();
  };
}
