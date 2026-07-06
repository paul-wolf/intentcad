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
  kind?: 'part' | 'sketch';
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

// ── 3D build (server-side CadQuery, experimental) ──
// Mirrors backend/modeling/schemas.py. The request is self-contained: sketches
// are sent inline rather than referenced by id.

export interface BuildEntity {
  type: 'line' | 'circle' | 'rectangle';
  construction?: boolean;
  points?: { x: number; y: number }[];
  closed?: boolean;
  bulge?: number[];
  center?: { x: number; y: number };
  radius?: number;
  width?: number;
  height?: number;
  anchor?: 'center' | 'corner';
}

export interface BuildSketch {
  id: string;
  entities: BuildEntity[];
}

export interface BuildAxis {
  start: { x: number; y: number };
  end: { x: number; y: number };
}

export interface BuildFeature {
  id: string;
  type: 'extrude' | 'revolve' | 'fillet' | 'chamfer' | 'counterbore' | 'trim';
  sketchId: string;
  operation?: 'add' | 'remove';
  // extrude
  distance?: number;
  direction?: 'forward' | 'reverse' | 'both';
  // revolve
  axis?: BuildAxis;
  angle?: number;
  // fillet / chamfer (modify the running result)
  edges?: string;
  radius?: number;
  // counterbore (recesses the top face at the sketch's circles)
  cboreDia?: number;
  cboreDepth?: number;
  // trim (cut past a plane)
  trimAxis?: 'X' | 'Y' | 'Z';
  at?: number;
  keep?: 'min' | 'max';
  trimFace?: string;  // face tag ('back'|'front'|…) — trim flush with that face
  // placement
  plane?: 'XY' | 'XZ' | 'YZ';
  tilt?: number;
  tiltAxis?: 'X' | 'Y' | 'Z';
  offset?: [number, number, number];
}

export interface BuildRequest {
  sketches: BuildSketch[];
  features: BuildFeature[];
  tolerance?: number;
}

export interface BuildResponse {
  mesh: { positions: number[]; normals: number[]; triangle_count: number };
  step: string;
  metrics: {
    volume: number;
    area: number;
    bbox_min: [number, number, number];
    bbox_max: [number, number, number];
    center: [number, number, number];
  };
  faces: { index: number; kind: string; area: number; center: [number, number, number]; normal: [number, number, number]; tags: string[] }[];
  edges: { index: number; kind: string; length: number; center: [number, number, number]; start: [number, number, number]; end: [number, number, number]; faces: string[][]; faceIndices: number[]; polyline: [number, number, number][] }[];
  warnings: string[];
}

export const buildApi = {
  build(payload: BuildRequest): Promise<BuildResponse> {
    return request('/build/', { method: 'POST', body: JSON.stringify(payload) });
  },
  resolve(payload: ResolveRequest): Promise<ResolveResponse> {
    return request('/build/resolve', { method: 'POST', body: JSON.stringify(payload) });
  },
  chat(payload: ChatRequest): Promise<ChatResponse> {
    return request('/build/chat', { method: 'POST', body: JSON.stringify(payload) });
  },
  run(code: string): Promise<RunResponse> {
    return request('/build/run', { method: 'POST', body: JSON.stringify({ code }) });
  },
  export(code: string, format: 'stl' | 'step'): Promise<{ format: string; data: string }> {
    return request('/build/export', { method: 'POST', body: JSON.stringify({ code, format }) });
  },
  edit(payload: { code: string; instruction: string; context?: string; document_id?: string;
                  history?: { role: string; text: string }[] }): Promise<EditResponse> {
    return request('/build/edit', { method: 'POST', body: JSON.stringify(payload) });
  },
  usage(documentId: string): Promise<UsageResponse> {
    return request(`/build/usage?document=${encodeURIComponent(documentId)}`);
  },
  setParams(code: string, params: Record<string, number>): Promise<{ code: string }> {
    return request('/build/set_params', { method: 'POST', body: JSON.stringify({ code, params }) });
  },
  sensitivity(code: string): Promise<{ params: Record<string, DimInfo> }> {
    return request('/build/sensitivity', { method: 'POST', body: JSON.stringify({ code }) });
  },
};

/** What a parameter controls, derived by perturbation (see backend sensitivity). */
export interface DimInfo {
  faces: number[];
  value: number;
  anchor: [number, number, number] | null;
  dir: [number, number, number] | null;
  kind: 'length' | 'callout';
}

export interface EditResponse {
  kind: 'edit' | 'question';
  code: string; note?: string; question: string;
  tokens_in: number; tokens_out: number; cost_usd: number;
}

export interface UsageTotals { edits: number; tokens_in: number; tokens_out: number; cost_usd: number }
export interface UsageResponse { document: UsageTotals; all_time: UsageTotals }

// ── build123d engine (the model is a script) ──
export interface RunFace {
  index: number; start: number; count: number;
  kind: string; area: number; center: [number, number, number]; normal: [number, number, number];
  radius?: number | null;   // radius of a cylindrical face (hole/boss), else null
  size?: [number, number, number];   // bounding-box extents of the face
}

export interface RunEdge {
  index: number; kind: string; faceIndices: number[]; polyline: [number, number, number][];
}

export interface RunResponse {
  mesh: { positions: number[]; normals: number[]; triangle_count: number };
  faces: RunFace[];
  edges: RunEdge[];
  params: Record<string, number>;
  metrics: { volume: number; area: number; bbox_min: [number, number, number]; bbox_max: [number, number, number] };
  warning?: string;
}

// ── chat agent (instruction → feature-tree operations) ──
// Mirrors backend/modeling/agent.py.

export interface ChatSketchMeta {
  id: string;
  name: string;
  entityCount: number;
}

export interface ChatRequest {
  instruction: string;
  sketches: ChatSketchMeta[];
  features: BuildFeature[];
  faces: BuildResponse['faces'];
  edges: BuildResponse['edges'];
}

export interface ChatResponse {
  status: 'ok' | 'clarify';
  reply?: string;
  operations?: BuildFeature[];
  question?: string;
}

// ── reference resolver (natural language → selector) ──
// Mirrors backend/modeling/resolver.py. Given the inventory of an already-built
// result and a phrase, returns the formal selector it names.

export interface ResolveRequest {
  reference: string;
  faces: BuildResponse['faces'];
  edges: BuildResponse['edges'];
}

export interface ResolveResponse {
  status: 'resolved' | 'clarify';
  target?: 'face' | 'edge';
  selector?: string;
  indices?: number[];
  rationale?: string;
  question?: string;
}
