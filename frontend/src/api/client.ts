const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8951/api';

let csrfToken: string | null = null;

function getCsrfFromCookie(): string | null {
  const match = document.cookie
    .split('; ')
    .find((row) => row.startsWith('csrftoken='));
  return match ? match.split('=')[1]! : null;
}

async function ensureCsrfToken(): Promise<string> {
  const fromCookie = getCsrfFromCookie();
  if (fromCookie) {
    csrfToken = fromCookie;
    return csrfToken;
  }
  if (csrfToken) return csrfToken;
  const resp = await fetch(`${API_BASE}/auth/csrf`, { credentials: 'include' });
  const data = await resp.json();
  csrfToken = data.csrfToken;
  return csrfToken!;
}

export function clearCsrfToken() {
  csrfToken = null;
}

async function request<T>(
  path: string,
  opts: RequestInit = {},
): Promise<T> {
  const method = (opts.method || 'GET').toUpperCase();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...opts.headers as Record<string, string>,
  };

  if (method !== 'GET' && method !== 'HEAD') {
    const token = await ensureCsrfToken();
    headers['X-CSRFToken'] = token;
  }

  const resp = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers,
    credentials: 'include',
  });

  if (resp.status === 401 && !path.startsWith('/auth/')) {
    window.location.href = '/login';
    throw new Error('Not authenticated');
  }

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
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DocumentFull {
  id: string;
  name: string;
  data: Record<string, unknown>;
  history: unknown;
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

export const api = {
  listDocuments(projectId?: string): Promise<DocumentListItem[]> {
    const params = projectId ? `?project=${projectId}` : '';
    return request(`/documents/${params}`);
  },

  getDocument(id: string): Promise<DocumentFull> {
    return request(`/documents/${id}`);
  },

  createDocument(name: string, data: Record<string, unknown>, projectId?: string): Promise<DocumentFull> {
    return request('/documents/', {
      method: 'POST',
      body: JSON.stringify({ name, data, project_id: projectId }),
    });
  },

  updateDocument(id: string, payload: { name?: string; data?: Record<string, unknown>; history?: unknown }): Promise<DocumentFull> {
    return request(`/documents/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  },

  deleteDocument(id: string): Promise<void> {
    return request(`/documents/${id}`, { method: 'DELETE' });
  },
};
