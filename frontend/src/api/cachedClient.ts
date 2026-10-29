import { db } from './db';
import { api as rawApi } from './client';
import type { DocumentListItem, DocumentFull } from './client';
import { triggerSync } from './syncEngine';
import { savedData, savedHistory } from '@/utils/sketchAxes';

// Re-export types so consumers can import everything from cachedClient
export type { DocumentListItem, DocumentFull } from './client';
// Re-export clearCsrfToken for authStore
export { clearCsrfToken } from './client';

// ── Documents ──

// Saves of one document run one after another. Overlapping saves (the chat's
// and the autosave's) would each send the timestamp of the last confirmed save
// as their base; once the first lands, the server refuses the second as a
// conflict (409). In turn, each one sends the timestamp the one before got back.
const saving = new Map<string, Promise<unknown>>();
function inTurn<T>(id: string, run: () => Promise<T>): Promise<T> {
  const next = (saving.get(id) ?? Promise.resolve()).catch(() => undefined).then(run);
  saving.set(id, next);
  void next.catch(() => undefined).finally(() => { if (saving.get(id) === next) saving.delete(id); });
  return next;
}

// The version of each part's script this tab last had from the server
// (DocumentFull.code_version), in memory: every save sends it as code_base, so
// the server never lets this tab overwrite a script another tab or browser
// saved since (it refuses a save that changes the script, and keeps the newer
// script under one that doesn't). Per tab, not in IDB, which tabs share.
const codeBase = new Map<string, string>();
// ...and its script, so a tab can tell code it hasn't saved (typed, or a save
// the server refused) from the server's
const savedCode = new Map<string, string>();

/** The version of the script this tab has of document `id` (none: not known, no check). */
export function codeBaseOf(id: string): string | undefined {
  return codeBase.get(id);
}

/** The script of that version (none: not known). */
export function savedCodeOf(id: string): string | undefined {
  return savedCode.get(id);
}

/** This tab now shows the script of that version (it took the saved one). */
export function adoptCodeVersion(id: string, version: string | undefined, code?: unknown) {
  if (version) codeBase.set(id, version);
  else codeBase.delete(id);
  if (version && typeof code === 'string') savedCode.set(id, code);
  else savedCode.delete(id);
}

export const api = {
  async listDocuments(projectId?: string): Promise<DocumentListItem[]> {
    try {
      const serverList = await rawApi.listDocuments(projectId);
      for (const item of serverList) {
        await db.documents.put({ ...item, data: {}, project_id: item.project_id, updated_at: item.updated_at });
      }
      return serverList;
    } catch {
      // Offline — fall back to IDB, sorted by updated_at descending
      const cached = projectId
        ? await db.documents.where('project_id').equals(projectId).toArray()
        : await db.documents.toArray();
      return cached
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .map((d) => ({
          id: d.id,
          name: d.name,
          project_id: d.project_id,
          created_at: d.updated_at,
          updated_at: d.updated_at,
        }));
    }
  },

  async getDocument(id: string): Promise<DocumentFull> {
    const [pending, cached] = await Promise.all([
      db.syncQueue.where('[table+entityId]').equals(['documents', id]).count(),
      db.documents.get(id),
    ]);

    try {
      const server = await rawApi.getDocument(id);

      // IDB has genuine unconfirmed local changes only when:
      // 1. There are pending queue entries
      // 2. IDB has data
      // 3. The server hasn't changed since our last confirmed save
      //    (server_confirmed_updated_at is the timestamp of the last save the server acknowledged;
      //     if it's undefined the entry pre-dates this field — treat server as authoritative)
      const confirmedAt = cached?.server_confirmed_updated_at;
      const idbHasLocalChanges =
        pending > 0 &&
        cached != null &&
        Object.keys(cached.data ?? {}).length > 0 &&
        confirmedAt != null &&
        confirmedAt >= server.updated_at;

      if (idbHasLocalChanges) {
        adoptCodeVersion(id, undefined);   // unconfirmed local changes: not a version the server has
        triggerSync();
        return {
          id: cached!.id,
          name: cached!.name,
          data: cached!.data,
          history: cached!.history,
          project_id: cached!.project_id,
          created_at: cached!.updated_at,
          updated_at: cached!.updated_at,
        };
      }

      // Server is authoritative — update IDB and discard any stale queue entries
      await db.documents.put({
        id: server.id,
        name: server.name,
        data: server.data,
        history: server.history,
        project_id: server.project_id,
        updated_at: server.updated_at,
        server_confirmed_updated_at: server.updated_at,
      });
      if (pending > 0) {
        await db.syncQueue.where('[table+entityId]').equals(['documents', id]).delete();
      }
      adoptCodeVersion(id, server.code_version, server.data?.modelCode);
      return server;
    } catch {
      adoptCodeVersion(id, undefined);
      // Offline — fall back to IDB
      if (cached && cached.data && Object.keys(cached.data).length > 0) {
        return {
          id: cached.id,
          name: cached.name,
          data: cached.data,
          history: cached.history,
          project_id: cached.project_id,
          created_at: cached.updated_at,
          updated_at: cached.updated_at,
        };
      }
      throw new Error('Document not available: server unreachable and no local cache');
    }
  },

  async createDocument(name: string, data: Record<string, unknown>, projectId?: string): Promise<DocumentFull> {
    data = savedData(data);   // sketch axes are derived on load, not saved
    // For creates, we need the server to assign the ID
    // Try server first; if offline, create with temp ID
    try {
      const result = await rawApi.createDocument(name, data, projectId);
      await db.documents.put({
        id: result.id,
        name: result.name,
        data: result.data,
        history: result.history,
        project_id: result.project_id,
        updated_at: result.updated_at,
      });
      return result;
    } catch {
      // Offline — create with temp ID
      const tempId = crypto.randomUUID();
      const now = new Date().toISOString();
      const doc = { id: tempId, name, data, project_id: projectId ?? null, updated_at: now };
      await db.documents.put(doc);
      await db.syncQueue.add({
        table: 'documents',
        entityId: tempId,
        method: 'create',
        payload: { name, data, project_id: projectId },
        timestamp: Date.now(),
      });
      triggerSync();
      return { ...doc, history: undefined, created_at: now };
    }
  },

  /** `codeBase`: the script version to send as code_base (default: this tab's,
   *  see codeBase; null: none, an overwrite the user chose). A refused save
   *  throws {conflict: true}, with codeChanged when it was the script. */
  updateDocument(id: string, payload: { name?: string; data?: Record<string, unknown>; history?: unknown; project_id?: string; version_label?: string; snapshot?: boolean },
                 codeBaseFor?: string | null): Promise<DocumentFull> {
    // one save of a document at a time (see inTurn)
    return inTurn(id, async () => {
      const codeVersion = codeBaseFor === undefined ? codeBase.get(id) : codeBaseFor ?? undefined;
      // sketch axes are derived on load, not saved
      payload = { ...payload, ...(payload.data ? { data: savedData(payload.data) } : {}), ...(payload.history ? { history: savedHistory(payload.history) } : {}) };
      const now = new Date().toISOString();
      const existing = await db.documents.get(id);
      const optimistic = {
        id,
        name: payload.name ?? existing?.name ?? '',
        data: payload.data ?? existing?.data ?? {},
        history: payload.history ?? existing?.history,
        project_id: payload.project_id ?? existing?.project_id ?? null,
        updated_at: now,
        server_confirmed_updated_at: existing?.server_confirmed_updated_at,
      };

      // Write to IDB immediately so offline edits are never lost
      await db.documents.put(optimistic);

      try {
        // Send the version we last saw so the server can reject a stale overwrite.
        const base = existing?.server_confirmed_updated_at ?? existing?.updated_at;
        const result = await rawApi.updateDocument(id, { ...payload, ...(base ? { base_updated_at: base } : {}),
                                                         ...(codeVersion ? { code_base: codeVersion } : {}) });
        // the server saved this tab's script: that is its version now (when it
        // kept a newer one instead, this tab still has the old one)
        if (result.data?.modelCode === payload.data?.modelCode) adoptCodeVersion(id, result.code_version, result.data?.modelCode);
        // Update IDB with the server's confirmed timestamp
        await db.documents.put({
          id: result.id,
          name: result.name,
          data: result.data ?? optimistic.data,
          history: result.history ?? optimistic.history,
          project_id: result.project_id,
          updated_at: result.updated_at,
          server_confirmed_updated_at: result.updated_at,
        });
        // Clear any stale pending queue entries now that the server has the latest
        await db.syncQueue.where('[table+entityId]').equals(['documents', id]).delete();
        return result;
      } catch (err) {
        const msg = String(err);
        if (msg.includes('API 409')) {
          // Stale write refused by the server — DON'T overwrite. Pull the server's
          // current version into IDB so local reflects the truth, and surface it.
          try {
            const server = await rawApi.getDocument(id);
            await db.documents.put({
              id: server.id, name: server.name, data: server.data, history: server.history,
              project_id: server.project_id, updated_at: server.updated_at,
              server_confirmed_updated_at: server.updated_at,
            });
          } catch { /* ignore refetch failure */ }
          throw Object.assign(new Error('conflict'), { conflict: true, codeChanged: !!(err as { codeChanged?: boolean }).codeChanged });
        }
        if (msg.includes('API 4')) {
          // 4xx — validation/auth error, queuing would not help
          throw err;
        }
        // Network error — queue for sync when back online
        await db.syncQueue.add({
          table: 'documents',
          entityId: id,
          method: 'update',
          payload,
          timestamp: Date.now(),
        });
        triggerSync();
        throw Object.assign(new Error('offline'), { queued: true });
      }
    });
  },

  async deleteDocument(id: string): Promise<void> {
    await db.documents.delete(id);
    await db.syncQueue.add({
      table: 'documents',
      entityId: id,
      method: 'delete',
      payload: {},
      timestamp: Date.now(),
    });
    triggerSync();
  },
};
