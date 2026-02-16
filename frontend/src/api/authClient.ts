import type { User, UserDetail, OrganisationDetail } from '@/types/auth';

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8951/api';
const AUTH_BASE = `${API_BASE}/auth`;

function getCsrfFromCookie(): string | null {
  const match = document.cookie
    .split('; ')
    .find((row) => row.startsWith('csrftoken='));
  return match ? match.split('=')[1]! : null;
}

async function ensureCsrfToken(): Promise<string> {
  const fromCookie = getCsrfFromCookie();
  if (fromCookie) return fromCookie;
  const resp = await fetch(`${AUTH_BASE}/csrf`, { credentials: 'include' });
  const data = await resp.json();
  return data.csrfToken;
}

async function authRequest<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const method = (opts.method || 'GET').toUpperCase();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...opts.headers as Record<string, string>,
  };

  if (method !== 'GET' && method !== 'HEAD') {
    headers['X-CSRFToken'] = await ensureCsrfToken();
  }

  const resp = await fetch(`${AUTH_BASE}${path}`, {
    ...opts,
    headers,
    credentials: 'include',
  });

  if (resp.status === 204) return undefined as T;
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({ message: 'Request failed' }));
    throw new Error(body.message || `API ${resp.status}`);
  }
  return resp.json() as Promise<T>;
}

export const authApi = {
  me(): Promise<User> {
    return authRequest('/me');
  },

  login(username: string, password: string): Promise<{ user: User; message: string }> {
    return authRequest('/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
  },

  logout(): Promise<{ message: string }> {
    return authRequest('/logout', { method: 'POST' });
  },

  resetPassword(token: string, password: string): Promise<{ message: string }> {
    return authRequest('/password-reset', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    });
  },

  // ── User management ──

  listUsers(): Promise<UserDetail[]> {
    return authRequest('/manage/users');
  },

  getUser(id: string): Promise<UserDetail> {
    return authRequest(`/manage/users/${id}`);
  },

  createUser(data: {
    username: string;
    email: string;
    first_name?: string;
    last_name?: string;
    organisation_id?: string;
    is_staff?: boolean;
    is_superuser?: boolean;
  }): Promise<UserDetail> {
    return authRequest('/manage/users', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  updateUser(id: string, data: Record<string, unknown>): Promise<UserDetail> {
    return authRequest(`/manage/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },

  deleteUser(id: string): Promise<void> {
    return authRequest(`/manage/users/${id}`, { method: 'DELETE' });
  },

  unlockUser(id: string): Promise<{ message: string }> {
    return authRequest(`/manage/users/${id}/unlock`, { method: 'POST' });
  },

  generateResetLink(id: string): Promise<{ token: string; reset_url: string; expires_at: string }> {
    return authRequest(`/manage/users/${id}/reset-link`, { method: 'POST' });
  },

  // ── Organisation management ──

  listOrganisations(): Promise<OrganisationDetail[]> {
    return authRequest('/manage/organisations');
  },

  createOrganisation(data: {
    name: string;
    slug: string;
    description?: string;
    email?: string;
    phone?: string;
    website?: string;
  }): Promise<OrganisationDetail> {
    return authRequest('/manage/organisations', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  updateOrganisation(id: string, data: Record<string, unknown>): Promise<OrganisationDetail> {
    return authRequest(`/manage/organisations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },

  deleteOrganisation(id: string): Promise<void> {
    return authRequest(`/manage/organisations/${id}`, { method: 'DELETE' });
  },
};
