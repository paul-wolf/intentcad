import { useDocumentStore } from '@/stores/documentStore';
import { api } from './client';

let timer: ReturnType<typeof setTimeout> | null = null;
let backendId: string | null = null;
let pendingId: string | null = null;
let pendingDoc: Record<string, unknown> | null = null;

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
  backendId = id;
}

function doSave(id: string, doc: Record<string, unknown>) {
  api.updateDocument(id, {
    name: (doc as { name: string }).name,
    data: doc,
  }).catch((err) => {
    console.error('[autoSave] PUT failed:', err);
  });
}

/** Schedule a debounced save of the current document state. */
export function requestSave() {
  const doc = useDocumentStore.getState().document;
  scheduleSave(doc as unknown as Record<string, unknown>);
}

/** Immediately persist any pending debounced save. */
export function flushSave() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (pendingId && pendingDoc) {
    doSave(pendingId, pendingDoc);
    pendingId = null;
    pendingDoc = null;
  }
}

function scheduleSave(doc: Record<string, unknown>) {
  if (!backendId) return;
  pendingId = backendId;
  pendingDoc = doc;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    if (pendingId && pendingDoc) {
      doSave(pendingId, pendingDoc);
      pendingId = null;
      pendingDoc = null;
    }
  }, DEBOUNCE_MS);
}

export function startAutoSave() {
  // Fire once immediately for the current state (covers migration on load)
  const current = useDocumentStore.getState();
  if (backendId) {
    scheduleSave(current.document as unknown as Record<string, unknown>);
  }

  const handleBeforeUnload = () => flushSave();
  window.addEventListener('beforeunload', handleBeforeUnload);

  const unsub = useDocumentStore.subscribe((state) => {
    if (!backendId) return;
    scheduleSave(state.document as unknown as Record<string, unknown>);
  });

  return () => {
    unsub();
    window.removeEventListener('beforeunload', handleBeforeUnload);
    flushSave();
  };
}
