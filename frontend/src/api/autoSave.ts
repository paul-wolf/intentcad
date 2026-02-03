import { useDocumentStore } from '@/stores/documentStore';
import { api } from './client';

let timer: ReturnType<typeof setTimeout> | null = null;
let backendId: string | null = null;

const DEBOUNCE_MS = 1500;

export function setBackendId(id: string | null) {
  console.log('[autoSave] setBackendId:', id);
  backendId = id;
}

export function getBackendId() {
  return backendId;
}

function save(doc: { name: string } & Record<string, unknown>) {
  console.log('[autoSave] save() called, backendId:', backendId);
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    if (!backendId) {
      console.log('[autoSave] timeout fired but no backendId, skipping');
      return;
    }
    try {
      console.log('[autoSave] sending PUT to', backendId);
      await api.updateDocument(backendId, {
        name: doc.name,
        data: doc as Record<string, unknown>,
      });
      console.log('[autoSave] PUT succeeded');
    } catch (err) {
      console.error('[autoSave] PUT failed:', err);
    }
  }, DEBOUNCE_MS);
}

export function startAutoSave() {
  console.log('[autoSave] startAutoSave() called, backendId:', backendId);

  // Fire once immediately for the current state (covers migration on load)
  const current = useDocumentStore.getState();
  if (backendId) {
    save(current.document as unknown as { name: string } & Record<string, unknown>);
  }

  return useDocumentStore.subscribe((state) => {
    console.log('[autoSave] store changed, backendId:', backendId);
    if (!backendId) return;
    save(state.document as unknown as { name: string } & Record<string, unknown>);
  });
}
