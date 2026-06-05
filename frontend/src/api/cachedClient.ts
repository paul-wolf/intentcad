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
    // Return IDB data, refresh from server in background
    const cached = projectId
      ? await db.documents.where('project_id').equals(projectId).toArray()
      : await db.documents.toArray();

    // Background refresh
    rawApi.listDocuments(projectId).then(async (serverList) => {
      const tx = db.documents;
      for (const item of serverList) {
        await tx.put({ ...item, data: {}, project_id: item.project_id, updated_at: item.updated_at });
      }
    }).catch(() => { /* offline, ignore */ });

    if (cached.length > 0) {
      return cached.map((d) => ({
        id: d.id,
        name: d.name,
        project_id: d.project_id,
        created_at: d.updated_at, // approximate
        updated_at: d.updated_at,
      }));
    }

    // No cache — must wait for server
    const serverList = await rawApi.listDocuments(projectId);
    for (const item of serverList) {
      await db.documents.put({ ...item, data: {}, project_id: item.project_id, updated_at: item.updated_at });
    }
    return serverList;
  },

  async getDocument(id: string): Promise<DocumentFull> {
    // If there are pending local writes, IDB is ahead of the server — use it as source of truth.
    // Otherwise, always fetch from the server to avoid loading stale cache from another session.
    const pending = await db.syncQueue.where('[table+entityId]').equals(['documents', id]).count();

    if (pending > 0) {
      const cached = await db.documents.get(id);
      if (cached && cached.data && Object.keys(cached.data).length > 0) {
        triggerSync();
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
    }

    // No pending local writes — server is the source of truth.
    try {
      const server = await rawApi.getDocument(id);
      await db.documents.put({
        id: server.id,
        name: server.name,
        data: server.data,
        history: server.history,
        project_id: server.project_id,
        updated_at: server.updated_at,
      });
      return server;
    } catch {
      // Offline — fall back to IDB cache
      const cached = await db.documents.get(id);
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

    // Write to IDB immediately
    const existing = await db.documents.get(id);
    const updated = {
      id,
      name: payload.name ?? existing?.name ?? '',
      data: payload.data ?? existing?.data ?? {},
      history: payload.history ?? existing?.history,
      project_id: existing?.project_id ?? null,
      updated_at: now,
    };
    await db.documents.put(updated);

    // Enqueue for server sync
    await db.syncQueue.add({
      table: 'documents',
      entityId: id,
      method: 'update',
      payload,
      timestamp: Date.now(),
    });
    triggerSync();

    return { ...updated, created_at: now };
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
    const cached = projectId
      ? await db.parts.where('project_id').equals(projectId).toArray()
      : await db.parts.toArray();

    rawPartApi.listParts(projectId).then(async (serverList) => {
      for (const item of serverList) {
        await db.parts.put({ ...item, data: {}, project_id: item.project_id, updated_at: item.updated_at });
      }
    }).catch(() => {});

    if (cached.length > 0) {
      return cached.map((p) => ({
        id: p.id,
        name: p.name,
        project_id: p.project_id,
        created_at: p.updated_at,
        updated_at: p.updated_at,
      }));
    }

    const serverList = await rawPartApi.listParts(projectId);
    for (const item of serverList) {
      await db.parts.put({ ...item, data: {}, project_id: item.project_id, updated_at: item.updated_at });
    }
    return serverList;
  },

  async getPart(id: string): Promise<PartFull> {
    const pending = await db.syncQueue.where('[table+entityId]').equals(['parts', id]).count();

    if (pending > 0) {
      const cached = await db.parts.get(id);
      if (cached && cached.data && Object.keys(cached.data).length > 0) {
        triggerSync();
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
    }

    try {
      const server = await rawPartApi.getPart(id);
      await db.parts.put({
        id: server.id,
        name: server.name,
        data: server.data,
        history: server.history,
        project_id: server.project_id,
        updated_at: server.updated_at,
      });
      return server;
    } catch {
      const cached = await db.parts.get(id);
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
    const updated = {
      id,
      name: payload.name ?? existing?.name ?? '',
      data: payload.data ?? existing?.data ?? {},
      history: payload.history ?? existing?.history,
      project_id: existing?.project_id ?? null,
      updated_at: now,
    };
    await db.parts.put(updated);

    await db.syncQueue.add({
      table: 'parts',
      entityId: id,
      method: 'update',
      payload,
      timestamp: Date.now(),
    });
    triggerSync();

    return { ...updated, created_at: now };
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
