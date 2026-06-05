import Dexie, { type Table } from 'dexie';

export interface CachedDocument {
  id: string;
  name: string;
  data: Record<string, unknown>;
  history?: unknown;
  project_id: string | null;
  updated_at: string;
  server_confirmed_updated_at?: string; // set only when server confirms a save
}

export interface CachedPart {
  id: string;
  name: string;
  data: Record<string, unknown>;
  history?: unknown;
  project_id: string | null;
  updated_at: string;
  server_confirmed_updated_at?: string;
}

export interface CachedProject {
  id: string;
  name: string;
  description: string;
  updated_at: string;
}

export interface SyncQueueEntry {
  autoId?: number;
  table: string;
  entityId: string;
  method: 'create' | 'update' | 'delete';
  payload: Record<string, unknown>;
  timestamp: number;
}

class IntentDB extends Dexie {
  documents!: Table<CachedDocument, string>;
  parts!: Table<CachedPart, string>;
  projects!: Table<CachedProject, string>;
  syncQueue!: Table<SyncQueueEntry, number>;

  constructor() {
    super('intentcad');
    this.version(1).stores({
      documents: 'id, project_id, updated_at',
      parts: 'id, project_id, updated_at',
      projects: 'id, updated_at',
      camJobs: 'id, document_id, updated_at',
      syncQueue: '++autoId, [table+entityId]',
    });
    this.version(2).stores({
      documents: 'id, project_id, updated_at',
      parts: 'id, project_id, updated_at',
      projects: 'id, updated_at',
      camJobs: 'id, document_id, updated_at',
      syncQueue: '++autoId, [table+entityId], timestamp',
    });
    this.version(3).stores({
      documents: 'id, project_id, updated_at',
      parts: 'id, project_id, updated_at',
      projects: 'id, updated_at',
      camJobs: null,
      syncQueue: '++autoId, [table+entityId], timestamp',
    });
  }
}

export const db = new IntentDB();
