const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8951/api';

async function request<T>(
  path: string,
  opts: RequestInit = {},
): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...opts.headers as Record<string, string> },
    ...opts,
  });
  if (resp.status === 204) return undefined as T;
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`API ${resp.status}: ${body}`);
  }
  return resp.json() as Promise<T>;
}

export interface DocumentListItem {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface DocumentFull {
  id: string;
  name: string;
  data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export const api = {
  listDocuments(): Promise<DocumentListItem[]> {
    return request('/documents/');
  },

  getDocument(id: string): Promise<DocumentFull> {
    return request(`/documents/${id}`);
  },

  createDocument(name: string, data: Record<string, unknown>): Promise<DocumentFull> {
    return request('/documents/', {
      method: 'POST',
      body: JSON.stringify({ name, data }),
    });
  },

  updateDocument(id: string, payload: { name?: string; data?: Record<string, unknown> }): Promise<DocumentFull> {
    return request(`/documents/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  },

  deleteDocument(id: string): Promise<void> {
    return request(`/documents/${id}`, { method: 'DELETE' });
  },
};
