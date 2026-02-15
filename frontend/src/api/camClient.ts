import type { CamProfileSummary, CamJobSummary } from '@/types/cam';

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8951/api';
const CAM_BASE = `${API_BASE}/cam`;

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const resp = await fetch(path, {
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

async function requestBlob(path: string): Promise<Blob> {
  const resp = await fetch(path);
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`API ${resp.status}: ${body}`);
  }
  return resp.blob();
}

export const camApi = {
  // ── Profiles ──

  listProfiles(): Promise<CamProfileSummary[]> {
    return request(`${CAM_BASE}/profiles/`);
  },

  createProfile(data: { name: string; config: Record<string, unknown> }) {
    return request(`${CAM_BASE}/profiles/`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  getProfile(id: string) {
    return request<Record<string, unknown>>(`${CAM_BASE}/profiles/${id}`);
  },

  updateProfile(id: string, data: { name?: string; config?: Record<string, unknown> }) {
    return request(`${CAM_BASE}/profiles/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  deleteProfile(id: string): Promise<void> {
    return request(`${CAM_BASE}/profiles/${id}`, { method: 'DELETE' });
  },

  // ── Jobs ──

  listJobs(documentId: string): Promise<CamJobSummary[]> {
    return request(`${CAM_BASE}/jobs/?document=${documentId}`);
  },

  createJob(data: { document_id: string; name: string; profile_id?: string; config?: Record<string, unknown> }) {
    return request<Record<string, unknown>>(`${CAM_BASE}/jobs/`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  getJob(id: string) {
    return request<Record<string, unknown>>(`${CAM_BASE}/jobs/${id}`);
  },

  updateJob(id: string, data: { name?: string; profile_id?: string; config?: Record<string, unknown> }) {
    return request<Record<string, unknown>>(`${CAM_BASE}/jobs/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  deleteJob(id: string): Promise<void> {
    return request(`${CAM_BASE}/jobs/${id}`, { method: 'DELETE' });
  },

  generateJob(id: string, gcode: string, errors: unknown[]) {
    return request<Record<string, unknown>>(`${CAM_BASE}/jobs/${id}/generate`, {
      method: 'POST',
      body: JSON.stringify({ gcode, errors }),
    });
  },

  downloadJob(id: string): Promise<Blob> {
    return requestBlob(`${CAM_BASE}/jobs/${id}/download`);
  },

  // ── AI Advisor ──

  suggestPlan(data: { document_data: Record<string, unknown>; profile_config?: Record<string, unknown>; material?: string }) {
    return request<{ config: Record<string, unknown>; notes: string[] }>(`${CAM_BASE}/advisor/suggest`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
};
