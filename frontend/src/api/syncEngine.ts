import { db } from './db';
import { api } from './client';
import { projectApi } from './projectClient';
import { addLog } from '@/stores/logStore';

let syncing = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 1000;
const MAX_RETRY_DELAY = 30000;

/** Start listening for online/offline events. Call once at app boot. */
export function startSyncEngine() {
  window.addEventListener('online', () => {
    addLog('info', 'Back online — syncing...');
    retryDelay = 1000;
    triggerSync();
  });
  window.addEventListener('offline', () => {
    addLog('info', 'Offline — changes will sync when reconnected');
  });
  // Drain any entries left from a previous session
  triggerSync();
}

/** Trigger a sync attempt. Safe to call frequently — deduplicates internally. */
export function triggerSync() {
  if (syncing || !navigator.onLine) return;
  processQueue();
}

async function processQueue() {
  if (syncing) return;
  syncing = true;

  try {
    // Deduplicate: for each (table, entityId), keep only the latest entry
    const all = await db.syncQueue.orderBy('timestamp').toArray();
    if (all.length === 0) { syncing = false; return; }

    const latest = new Map<string, typeof all[0]>();
    for (const entry of all) {
      const key = `${entry.table}:${entry.entityId}`;
      latest.set(key, entry);
    }

    for (const entry of latest.values()) {
      try {
        await dispatchSync(entry);
        // Remove all entries for this (table, entityId) — including older duplicates
        await db.syncQueue
          .where('[table+entityId]')
          .equals([entry.table, entry.entityId])
          .delete();
        retryDelay = 1000; // Reset backoff on success
      } catch (err) {
        const msg = String(err);
        // 4xx errors are not retryable (validation errors, not found, etc.)
        if (msg.includes('API 4')) {
          console.error(`[sync] Non-retryable error for ${entry.table}/${entry.entityId}:`, err);
          // Try to include the entity name for a clearer error message
          let entityLabel = entry.entityId;
          try {
            if (entry.table === 'documents') {
              const doc = await db.documents.get(entry.entityId);
              if (doc?.name) entityLabel = `"${doc.name}"`;
            }
          } catch { /* ignore */ }
          addLog('error', `Sync failed for ${entityLabel}: ${msg}. Check the document for unsupported content.`);
          await db.syncQueue
            .where('[table+entityId]')
            .equals([entry.table, entry.entityId])
            .delete();
        } else {
          // Network error — schedule retry with backoff
          console.warn(`[sync] Will retry ${entry.table}/${entry.entityId}:`, err);
          scheduleRetry();
          syncing = false;
          return;
        }
      }
    }
  } catch (err) {
    console.error('[sync] Queue processing error:', err);
  }

  syncing = false;
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
    triggerSync();
  }, retryDelay);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function dispatchSync(entry: { table: string; entityId: string; method: string; payload: Record<string, unknown> }) {
  const { table, entityId, method, payload } = entry;

  switch (table) {
    case 'documents':
      if (method === 'update') await api.updateDocument(entityId, payload);
      else if (method === 'create') await api.createDocument(payload.name as string, payload.data as Record<string, unknown>, payload.project_id as string | undefined);
      else if (method === 'delete') await api.deleteDocument(entityId);
      break;
    case 'projects':
      if (method === 'update') await projectApi.updateProject(entityId, payload as { name?: string; description?: string });
      else if (method === 'create') await projectApi.createProject(payload.name as string, payload.description as string);
      else if (method === 'delete') await projectApi.deleteProject(entityId);
      break;
    default:
      console.warn(`[sync] Unknown table: ${table}`);
  }
}
