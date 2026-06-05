import { db } from './db';
import { api as rawApi, partApi as rawPartApi } from './client';
import type { DocumentListItem, DocumentFull, PartListItem, PartFull } from './client';
import { triggerSync } from './syncEngine';

// Re-export types so consumers can import everything from cachedClient
export type { DocumentListItem, DocumentFull, PartListItem, PartFull } from './client';
// Re-export clearCsrfToken for authStore
export { clearCsrfToken } from './client';

// ── Documents ──

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
      return server;
    } catch {
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

  async updateDocument(id: string, payload: { name?: string; data?: Record<string, unknown>; history?: unknown }): Promise<DocumentFull> {
    const now = new Date().toISOString();
    const existing = await db.documents.get(id);
    const optimistic = {
      id,
      name: payload.name ?? existing?.name ?? '',
      data: payload.data ?? existing?.data ?? {},
      history: payload.history ?? existing?.history,
      project_id: existing?.project_id ?? null,
      updated_at: now,
    };

    // Write to IDB immediately so offline edits are never lost
    await db.documents.put(optimistic);

    try {
      const result = await rawApi.updateDocument(id, payload);
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

// ── Parts ──

export const partApi = {
  async listParts(projectId?: string): Promise<PartListItem[]> {
    try {
      const serverList = await rawPartApi.listParts(projectId);
      for (const item of serverList) {
        await db.parts.put({ ...item, data: {}, project_id: item.project_id, updated_at: item.updated_at });
      }
      return serverList;
    } catch {
      const cached = projectId
        ? await db.parts.where('project_id').equals(projectId).toArray()
        : await db.parts.toArray();
      return cached
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .map((p) => ({
          id: p.id,
          name: p.name,
          project_id: p.project_id,
          created_at: p.updated_at,
          updated_at: p.updated_at,
        }));
    }
  },

  async getPart(id: string): Promise<PartFull> {
    const [pending, cached] = await Promise.all([
      db.syncQueue.where('[table+entityId]').equals(['parts', id]).count(),
      db.parts.get(id),
    ]);

    try {
      const server = await rawPartApi.getPart(id);

      const confirmedAt = cached?.server_confirmed_updated_at;
      const idbHasLocalChanges =
        pending > 0 &&
        cached != null &&
        Object.keys(cached.data ?? {}).length > 0 &&
        confirmedAt != null &&
        confirmedAt >= server.updated_at;

      if (idbHasLocalChanges) {
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

      await db.parts.put({
        id: server.id,
        name: server.name,
        data: server.data,
        history: server.history,
        project_id: server.project_id,
        updated_at: server.updated_at,
        server_confirmed_updated_at: server.updated_at,
      });
      if (pending > 0) {
        await db.syncQueue.where('[table+entityId]').equals(['parts', id]).delete();
      }
      return server;
    } catch {
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
      throw new Error('Part not available: server unreachable and no local cache');
    }
  },

  async createPart(name: string, data: Record<string, unknown>, projectId?: string): Promise<PartFull> {
    try {
      const result = await rawPartApi.createPart(name, data, projectId);
      await db.parts.put({
        id: result.id,
        name: result.name,
        data: result.data,
        history: result.history,
        project_id: result.project_id,
        updated_at: result.updated_at,
      });
      return result;
    } catch {
      const tempId = crypto.randomUUID();
      const now = new Date().toISOString();
      const part = { id: tempId, name, data, project_id: projectId ?? null, updated_at: now };
      await db.parts.put(part);
      await db.syncQueue.add({
        table: 'parts',
        entityId: tempId,
        method: 'create',
        payload: { name, data, project_id: projectId },
        timestamp: Date.now(),
      });
      triggerSync();
      return { ...part, history: undefined, created_at: now };
    }
  },

  async updatePart(id: string, payload: { name?: string; data?: Record<string, unknown>; history?: unknown }): Promise<PartFull> {
    const now = new Date().toISOString();
    const existing = await db.parts.get(id);
    const optimistic = {
      id,
      name: payload.name ?? existing?.name ?? '',
      data: payload.data ?? existing?.data ?? {},
      history: payload.history ?? existing?.history,
      project_id: existing?.project_id ?? null,
      updated_at: now,
    };

    await db.parts.put(optimistic);

    try {
      const result = await rawPartApi.updatePart(id, payload);
      await db.parts.put({
        id: result.id,
        name: result.name,
        data: result.data ?? optimistic.data,
        history: result.history ?? optimistic.history,
        project_id: result.project_id,
        updated_at: result.updated_at,
        server_confirmed_updated_at: result.updated_at,
      });
      await db.syncQueue.where('[table+entityId]').equals(['parts', id]).delete();
      return result;
    } catch (err) {
      const msg = String(err);
      if (msg.includes('API 4')) {
        throw err;
      }
      await db.syncQueue.add({
        table: 'parts',
        entityId: id,
        method: 'update',
        payload,
        timestamp: Date.now(),
      });
      triggerSync();
      throw Object.assign(new Error('offline'), { queued: true });
    }
  },

  async deletePart(id: string): Promise<void> {
    await db.parts.delete(id);
    await db.syncQueue.add({
      table: 'parts',
      entityId: id,
      method: 'delete',
      payload: {},
      timestamp: Date.now(),
    });
    triggerSync();
  },
};
