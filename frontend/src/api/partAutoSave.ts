import { usePartStore } from '@/stores/partStore';
import { addLog } from '@/stores/logStore';
import { partApi } from './cachedClient';

let timer: ReturnType<typeof setTimeout> | null = null;
let backendId: string | null = null;
let pendingId: string | null = null;
let pendingData: Record<string, unknown> | null = null;
let pendingHistory: unknown = null;

const DEBOUNCE_MS = 1500;

export function getPartBackendId() {
  return backendId;
}

export function setPartBackendId(id: string | null) {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  pendingId = null;
  pendingData = null;
  pendingHistory = null;
  backendId = id;
}

function doSave(id: string, data: Record<string, unknown>, history?: unknown) {
  partApi.updatePart(id, {
    name: (data as { name: string }).name,
    data,
    history,
  }).then(() => {
    addLog('info', 'Part saved');
  }).catch((err) => {
    console.error('[partAutoSave] PUT failed:', err);
    addLog('error', `Part save failed: ${err}`);
  });
}

export function requestPartSave() {
  const state = usePartStore.getState();
  const data = state.part as unknown as Record<string, unknown>;
  const history = { undo: state.undoStack, redo: state.redoStack };
  schedulePartSave(data, history);
}

export function flushPartSave() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (pendingId && pendingData) {
    doSave(pendingId, pendingData, pendingHistory ?? undefined);
    pendingId = null;
    pendingData = null;
    pendingHistory = null;
  }
}

function schedulePartSave(data: Record<string, unknown>, history?: unknown) {
  if (!backendId) return;
  pendingId = backendId;
  pendingData = data;
  pendingHistory = history ?? null;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    if (pendingId && pendingData) {
      doSave(pendingId, pendingData, pendingHistory ?? undefined);
      pendingId = null;
      pendingData = null;
      pendingHistory = null;
    }
  }, DEBOUNCE_MS);
}

export function startPartAutoSave() {
  const current = usePartStore.getState();
  if (backendId) {
    const history = { undo: current.undoStack, redo: current.redoStack };
    schedulePartSave(current.part as unknown as Record<string, unknown>, history);
  }

  const handleBeforeUnload = () => flushPartSave();
  window.addEventListener('beforeunload', handleBeforeUnload);

  const unsub = usePartStore.subscribe((state) => {
    if (!backendId) return;
    const history = { undo: state.undoStack, redo: state.redoStack };
    schedulePartSave(state.part as unknown as Record<string, unknown>, history);
  });

  return () => {
    unsub();
    window.removeEventListener('beforeunload', handleBeforeUnload);
    flushPartSave();
  };
}
