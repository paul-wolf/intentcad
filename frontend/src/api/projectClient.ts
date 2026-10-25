import type { BriefVersion, Project, ProjectDetail, ProjectShare } from '@/types/project';

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8951/api';

function getCsrfFromCookie(): string | null {
  const match = document.cookie
    .split('; ')
    .find((row) => row.startsWith('csrftoken='));
  return match ? match.split('=')[1]! : null;
}

async function ensureCsrfToken(): Promise<string> {
  const fromCookie = getCsrfFromCookie();
  if (fromCookie) return fromCookie;
  const resp = await fetch(`${API_BASE}/auth/csrf`, { credentials: 'include' });
  const data = await resp.json();
  return data.csrfToken;
}

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const method = (opts.method || 'GET').toUpperCase();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...opts.headers as Record<string, string>,
  };

  if (method !== 'GET' && method !== 'HEAD') {
    headers['X-CSRFToken'] = await ensureCsrfToken();
  }

  const resp = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers,
    credentials: 'include',
  });

  if (resp.status === 401) {
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

export const projectApi = {
  listProjects(): Promise<Project[]> {
    return request('/projects/');
  },

  getProject(id: string): Promise<ProjectDetail> {
    return request(`/projects/${id}`);
  },

  createProject(name: string, description = ''): Promise<ProjectDetail> {
    return request('/projects/', {
      method: 'POST',
      body: JSON.stringify({ name, description }),
    });
  },

  /** Replace the project's parameters (PP["name"] in its parts' scripts);
   *  a bad or repeated name is refused with a message. */
  setParameters(id: string, parameters: import('@/types/project').ProjectParameter[]): Promise<ProjectDetail> {
    return request(`/projects/${id}/parameters`, { method: 'PUT', body: JSON.stringify({ parameters }) });
  },

  updateProject(id: string, data: { name?: string; description?: string }): Promise<ProjectDetail> {
    return request(`/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },

  deleteProject(id: string): Promise<void> {
    return request(`/projects/${id}`, { method: 'DELETE' });
  },

  /** Saves the brief; each different text is kept as a version (`label`: e.g. "AI proposal: …"). */
  saveBrief(id: string, text: string, label = ''): Promise<ProjectDetail> {
    return request(`/projects/${id}/brief`, { method: 'PUT', body: JSON.stringify({ text, label }) });
  },

  briefVersions(id: string): Promise<BriefVersion[]> {
    return request(`/projects/${id}/brief/versions`);
  },

  listShares(projectId: string): Promise<ProjectShare[]> {
    return request(`/projects/${projectId}/shares`);
  },

  addShare(projectId: string, email: string): Promise<ProjectShare> {
    return request(`/projects/${projectId}/shares`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  },

  removeShare(projectId: string, shareId: string): Promise<void> {
    return request(`/projects/${projectId}/shares/${shareId}`, { method: 'DELETE' });
  },
};
