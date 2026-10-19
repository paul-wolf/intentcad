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
    // a FormData body (file upload) sets its own multipart boundary
    ...(opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
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
    throw new ApiError(resp.status, body);
  }
  return resp.json() as Promise<T>;
}

/** The engine's structured remedy for a fillet/chamfer that doesn't fit: the
 *  size that failed, the largest that works, and — when that size is a script
 *  param — which param to set to what. */
export interface SizeFix {
  kind: 'fillet' | 'chamfer' | 'shell';
  size: number;
  max: number | null;
  suggest: number | null;
  param?: string;
  value?: number;
}

/** A non-2xx response. `detail` is the server's human message (the `message`
 *  field of a JSON error body, else the raw body); `message` keeps the
 *  `API <status>: …` form that callers string-match on. */
export class ApiError extends Error {
  status: number;
  detail: string;
  fix?: SizeFix;
  /** For a failed build: the script's editable params as far as it got. */
  params?: Record<string, number>;
  constructor(status: number, body: string) {
    let detail = body;
    let fix: SizeFix | undefined;
    let params: Record<string, number> | undefined;
    try {
      const j = JSON.parse(body);
      if (j && typeof j.message === 'string') detail = j.message;
      if (j && j.fix && typeof j.fix === 'object') fix = j.fix as SizeFix;
      if (j && j.params && typeof j.params === 'object') params = j.params as Record<string, number>;
    } catch { /* not JSON — keep the raw body */ }
    super(`API ${status}: ${detail}`);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
    this.fix = fix;
    this.params = params;
  }
}

/** The text to show a user for a caught error: the server's message for API
 *  errors (no status-code prefix), else the error's own message. */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.detail;
  return err instanceof Error ? err.message : String(err);
}

export interface DocumentListItem {
  id: string;
  name: string;
  project_id: string | null;
  created_at: string;
  updated_at: string;
  kind?: 'part' | 'sketch';
  thumbnail?: string | null;
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

  updateDocument(id: string, payload: { name?: string; data?: Record<string, unknown>; history?: unknown; project_id?: string; base_updated_at?: string; version_label?: string; snapshot?: boolean }): Promise<DocumentFull> {
    return request(`/documents/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  },

  deleteDocument(id: string): Promise<void> {
    return request(`/documents/${id}`, { method: 'DELETE' });
  },

  /** Upload a STEP file for the part's script to import as ASSETS["<sha256>"].
   *  The server trial-builds it first and refuses what the engine can't read. */
  uploadAsset(docId: string, file: File): Promise<AssetInfo> {
    const body = new FormData();
    body.append('file', file);
    return request(`/documents/${docId}/assets`, { method: 'POST', body });
  },

  listAssets(docId: string): Promise<AssetListItem[]> {
    return request(`/documents/${docId}/assets`);
  },

  listVersions(docId: string): Promise<VersionListItem[]> {
    return request(`/documents/${docId}/versions`);
  },

  getVersion(docId: string, versionId: string): Promise<VersionFull> {
    return request(`/documents/${docId}/versions/${versionId}`);
  },
};

/** An uploaded STEP file as the import script places it (mirrors documents/schemas.AssetOut). */
export interface AssetInfo {
  sha256: string;
  filename: string;
  size: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
  face_count: number;
}

/** Metadata for one uploaded file (mirrors documents/schemas.AssetListOut). */
export interface AssetListItem {
  sha256: string;
  filename: string;
  content_type: string;
  size: number;
  created_at: string;
}

/** Metadata for one immutable saved version (mirrors documents/schemas.VersionListOut). */
export interface VersionListItem {
  id: string;
  label: string;
  created_at: string;
  chars: number;
  preview: string;
}

/** A full version snapshot, including its document data (VersionOut). */
export interface VersionFull {
  id: string;
  label: string;
  created_at: string;
  data: Record<string, unknown>;
}

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
  cornerRadius?: number;
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
  // `documentId`: the part whose uploaded files the script imports (ASSETS[...])
  // `sketches`: the face sketches it extrudes (sketch("name")) as on screen — saved or not
  run(code: string, signal?: AbortSignal, documentId = '', sketches: Record<string, unknown> = {}): Promise<RunResponse> {
    return request('/build/run', { method: 'POST', body: JSON.stringify({ code, document_id: documentId, sketches }), signal });
  },
  export(code: string, format: 'stl' | 'step' | 'stl-parts' | 'dxf' | 'dxf-views', documentId = '',
         sketches: Record<string, unknown> = {}): Promise<{ format: string; data: string }> {
    return request('/build/export', { method: 'POST', body: JSON.stringify({ code, format, document_id: documentId, sketches }) });
  },
  edit(payload: { code: string; instruction: string; context?: string; document_id?: string;
                  history?: { role: string; text: string }[]; model?: string; production?: string;
                  build_error?: string }): Promise<EditResponse> {
    return request('/build/edit', { method: 'POST', body: JSON.stringify(payload) });
  },
  /** The Claude models the AI edit can use right now (discovered server-side
   *  from the Models API, so a new release appears without a frontend change). */
  models(): Promise<ModelsResponse> {
    return request('/build/models');
  },
  usage(documentId: string): Promise<UsageResponse> {
    return request(`/build/usage?document=${encodeURIComponent(documentId)}`);
  },
  setParams(code: string, params: Record<string, number>): Promise<{ code: string }> {
    return request('/build/set_params', { method: 'POST', body: JSON.stringify({ code, params }) });
  },
  // append an extrude of a face sketch to the script (its depth becomes a new P key)
  addExtrude(payload: { code: string; sketch: string; op: 'cut' | 'join' | 'new'; depth: number; through: boolean; flip: boolean;
                        datum?: boolean; both?: boolean }):
    Promise<{ code: string; param: string | null }> {
    return request('/build/add_extrude', { method: 'POST', body: JSON.stringify(payload) });
  },
  /** Append a shell() line, or rewrite the one on `line` (its thickness a P key). */
  addShell(payload: { code: string; remove: FaceRefSpec[]; thickness: number; inside: boolean; line?: number | null }):
    Promise<{ code: string; param: string | null }> {
    return request('/build/add_shell', { method: 'POST', body: JSON.stringify(payload) });
  },
  /** The shell()/holes() line spanning `line`, read back for its dialog. */
  opAt(code: string, line: number): Promise<OpAt> {
    return request('/build/op_at', { method: 'POST', body: JSON.stringify({ code, line }) });
  },
  sensitivity(code: string, documentId = '', sketches: Record<string, unknown> = {}): Promise<{ params: Record<string, DimInfo> }> {
    return request('/build/sensitivity', { method: 'POST', body: JSON.stringify({ code, document_id: documentId, sketches }) });
  },
};

/** What a parameter controls, derived by perturbation (see backend sensitivity). */
export interface DimInfo {
  faces: number[];
  value: number;
  /** face index -> how far that face's center moves per unit of the param */
  shifts: Record<number, [number, number, number]>;
  /** cylinder face index -> radius change per unit of the param */
  radial: Record<number, number>;
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
export interface ModelInfo {
  id: string;
  label: string;          // short menu name, e.g. "Opus 5"
  tier: 'fable' | 'opus' | 'sonnet' | 'haiku' | string;
  note: string;           // one line on when to pick it
  released: string;       // YYYY-MM-DD
  input_per_m: number;    // USD per 1M input tokens
  output_per_m: number;   // USD per 1M output tokens
}

export interface ModelsResponse {
  models: ModelInfo[];    // strongest tier first, newest first within a tier
  default: string;
  source: 'live' | 'static';
}

export interface UsageResponse { document: UsageTotals; all_time: UsageTotals }

// ── build123d engine (the model is a script) ──
export interface RunFace {
  index: number; start: number; count: number;
  kind: string; area: number; center: [number, number, number]; normal: [number, number, number];
  radius?: number | null;   // radius of a cylindrical face (hole/boss), else null
  size?: [number, number, number];   // bounding-box extents of the face
  /** How a script line names this face: face_ref(<ref>) (backend modeling/face_ref.py). */
  ref?: FaceRefSpec | null;
}

/** A face as a script line names it, found again when the part changes. */
export interface FaceRefSpec {
  center: [number, number, number]; normal: [number, number, number]; area: number;
  box?: [number, number, number, number]; kind?: string; hint?: string;
}

/** A face_ref() lookup in a build. */
export interface FaceRefReport { hint: string; status: 'found' | 'ambiguous' | 'not_found'; moved_by: number }

/** A Shell/Hole line read back (backend paramedit.op_at). */
export interface OpAt {
  op: 'shell' | 'holes'; line: number; end_line: number;
  args: Record<string, unknown>;
  /** argument -> the P key holding it */
  params: Record<string, string>;
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
  fix?: SizeFix;
  /** Present when the script called auto_round: what it rounded and what it couldn't. */
  auto_round?: AutoRoundReport | null;
  /** Present when the script called spoke/frame/window/truss_windows. */
  organic?: OrganicReport | null;
  /** Where each face sketch it extrudes went: each follows its face along the normal. */
  sketches?: import('@/build/faceSketch').SketchBindings;
  /** Each face_ref() lookup (shell's removed faces...), in order. */
  face_refs?: FaceRefReport[];
}

/** Mirrors backend modeling.schemas.AutoRoundReport. */
export interface AutoRoundReport {
  rounded: number;
  /** Eligible edges left sharp: reason 'failed' | 'protected' | 'timeout' | 'thin'. */
  skipped: { reason: string; kind: string; polyline: [number, number, number][] }[];
  /** Rounded below the requested radius (thin wall, or a half-radius retry). */
  capped: number;
  /** Of `rounded`: edges a neighbouring fillet's tangent chain took in. */
  merged: number;
  protected: number;
  elapsed: number;
}

/** Mirrors backend modeling.schemas.OrganicReport. */
export interface OrganicReport {
  /** frame() members joined, and the ones left out ("a–b: reason"). */
  members: number;
  failed_members: string[];
  /** window()/truss_windows() cuts made, and truss windows dropped: 'small' | 'failed' | 'protected'. */
  windows: number;
  dropped: { reason: string; at: number[] }[];
  /** Volume truss_windows took away, % (null when it wasn't called). */
  removed_pct: number | null;
  /** Printability ('thin' | 'overhang') and joints left less blended ('blend'). */
  warnings: { kind: string; message: string; at: number[] }[];
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
