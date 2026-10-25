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
  /** For a failed build: each revolve() it reached (where a profile crosses its axis). */
  revolves?: import('@/build/revolve').RevolveReport[];
  /** For a failed AI edit: what its calls cost before it gave up. */
  usage?: CallSpend;
  constructor(status: number, body: string) {
    let detail = body;
    let fix: SizeFix | undefined;
    let params: Record<string, number> | undefined;
    let usage: ApiError['usage'];
    let revolves: ApiError['revolves'];
    try {
      const j = JSON.parse(body);
      if (j && typeof j.message === 'string') detail = j.message;
      if (j && typeof j.cost_usd === 'number') {
        usage = { tokens_in: j.tokens_in ?? 0, tokens_out: j.tokens_out ?? 0, cost_usd: j.cost_usd,
                       cache_read_tokens: j.cache_read_tokens ?? 0 };
      }
      if (j && j.fix && typeof j.fix === 'object') fix = j.fix as SizeFix;
      if (j && j.params && typeof j.params === 'object') params = j.params as Record<string, number>;
      if (j && Array.isArray(j.revolves)) revolves = j.revolves;
    } catch { /* not JSON — keep the raw body */ }
    super(`API ${status}: ${detail}`);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
    this.fix = fix;
    this.params = params;
    this.usage = usage;
    this.revolves = revolves;
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
  /** a line on what it is or is for: the AI sees it in the project's parts list */
  description?: string;
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

  /** A copy in the same project ("Copy of <name>"): the model, its STEP files,
   *  the part's context files and CAM jobs; a fresh version history. */
  duplicateDocument(id: string): Promise<DocumentFull> {
    return request(`/documents/${id}/duplicate`, { method: 'POST' });
  },

  /** Sets the one-line description (saved without bumping the part's updated_at). */
  setDescription(id: string, description: string): Promise<DocumentListItem> {
    return request(`/documents/${id}/description`, { method: 'PUT', body: JSON.stringify({ description }) });
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
  /** `bed`: the print bed face (Document.printBed), found again in the build (RunResponse.bed). */
  run(code: string, signal?: AbortSignal, documentId = '', sketches: Record<string, unknown> = {},
      bed: FaceRefSpec | null = null): Promise<RunResponse> {
    return request('/build/run', { method: 'POST', body: JSON.stringify({ code, document_id: documentId, sketches, bed }), signal });
  },
  export(code: string, format: 'stl' | 'step' | 'stl-parts' | 'dxf' | 'dxf-views', documentId = '',
         sketches: Record<string, unknown> = {}, bed: FaceRefSpec | null = null): Promise<{ format: string; data: string }> {
    return request('/build/export', { method: 'POST', body: JSON.stringify({ code, format, document_id: documentId, sketches, bed }) });
  },
  edit(payload: { code: string; instruction: string; context?: string; document_id?: string;
                  history?: { role: string; text: string }[]; model?: string; production?: string;
                  build_error?: string; skip_context?: string[];
                  /** the ids of the project's parts and sketches @-mentioned in the instruction */
                  mentions?: string[] }): Promise<EditResponse> {
    return request('/build/edit', { method: 'POST', body: JSON.stringify(payload) });
  },
  /** The Claude models the AI edit can use right now (discovered server-side
   *  from the Models API, so a new release appears without a frontend change).
   *  `refresh` has the server ask the API again now (it allows that once a minute). */
  models(refresh = false): Promise<ModelsResponse> {
    return request(`/build/models${refresh ? '?refresh=true' : ''}`);
  },
  usage(documentId: string): Promise<UsageResponse> {
    return request(`/build/usage?document=${encodeURIComponent(documentId)}`);
  },
  setParams(code: string, params: Record<string, number>): Promise<{ code: string }> {
    return request('/build/set_params', { method: 'POST', body: JSON.stringify({ code, params }) });
  },
  /** Append an extrude of a face sketch (its depth a new P key), or rewrite
   *  the one on `line`: an op change rewrites the operator and sign. */
  addExtrude(payload: { code: string; sketch: string; op: ExtrudeOp; depth: number; through: boolean; flip: boolean;
                        datum?: boolean; both?: boolean; line?: number | null;
                        extent?: ExtrudeExtent; face?: FaceRefSpec | null; offset?: number | string; key?: string | null }):
    Promise<{ code: string; param: string | null }> {
    return request('/build/add_extrude', { method: 'POST', body: JSON.stringify(payload) });
  },
  /** Append a revolve of a face sketch, or rewrite the one on `line`. The
   *  axis is a line of the sketch ({line: id}), X / Y / Z, a straight edge or
   *  a cylindrical face; the angle (≤ 360°) a number or an expression. */
  addRevolve(payload: { code: string; sketch: string; op: ExtrudeOp; axis: import('@/build/revolve').RevolveAxis;
                        angle: number | string; both?: boolean; flip?: boolean; line?: number | null }):
    Promise<{ code: string }> {
    return request('/build/add_revolve', { method: 'POST', body: JSON.stringify(payload) });
  },
  /** Append a shell() line, or rewrite the one on `line` (its thickness a P key). */
  addShell(payload: { code: string; remove: FaceRefSpec[]; thickness: number; inside: boolean; line?: number | null }):
    Promise<{ code: string; param: string | null }> {
    return request('/build/add_shell', { method: 'POST', body: JSON.stringify(payload) });
  },
  /** Append a holes() line, or rewrite the one on `line` (its depth and changed sizes P keys). */
  addHoles(payload: HolesPayload & { code: string; line?: number | null }):
    Promise<{ code: string; param: string | null }> {
    return request('/build/add_holes', { method: 'POST', body: JSON.stringify(payload) });
  },
  /** Append a fillet() / chamfer() line on these edges, or rewrite the one on `line`
   *  (its size is a P key: fillet_r, chamfer_d, fillet2_r...). */
  addEdgeOp(payload: { code: string; op: EdgeOpKind; edges: EdgeRefSpec[]; size: number; line?: number | null }):
    Promise<{ code: string; param: string | null }> {
    return request('/build/add_edge_op', { method: 'POST', body: JSON.stringify(payload) });
  },
  /** Append a construction plane line (PLANES["name"] = offset_plane/edge_plane(...)),
   *  or rewrite the one on `line`; `renamed`: its old name when the name changed. */
  addPlane(payload: PlanePayload & { code: string; line?: number | null }):
    Promise<{ code: string; renamed: string | null }> {
    return request('/build/add_plane', { method: 'POST', body: JSON.stringify(payload) });
  },
  /** Rename a construction plane: every PLANES["old"] in the script. */
  renamePlane(code: string, old: string, name: string): Promise<{ code: string }> {
    return request('/build/rename_plane', { method: 'POST', body: JSON.stringify({ code, old, new: name }) });
  },
  /** Every hole size the Hole dialog offers (backend modeling/hole_presets.py). */
  holePresets(): Promise<HolePresets> {
    return request('/build/hole_presets');
  },
  /** The operation line spanning `line`, read back for its dialog. `datum`: the
   *  sketches on a base plane (an extrude's sign depends on it). */
  opAt(code: string, line: number, datum: string[] = []): Promise<OpAt> {
    return request('/build/op_at', { method: 'POST', body: JSON.stringify({ code, line, datum }) });
  },
  /** Rewrite an auto_round()/truss_windows() line: P refs update P, literals in
   *  place, `make_param` literals move into P; unknown arguments stay. */
  editArgs(payload: { code: string; line: number; op: ArgOpKind; values?: Record<string, unknown>;
                      keep?: KeepItem[] | null; make_param?: string[] }): Promise<{ code: string; params: string[] }> {
    return request('/build/edit_args', { method: 'POST', body: JSON.stringify(payload) });
  },
  /** The steps list: every operation in order, summed up. */
  steps(code: string, datum: string[] = [], points: Record<string, number> = {}): Promise<{ steps: Step[] }> {
    return request('/build/steps', { method: 'POST', body: JSON.stringify({ code, datum, points }) });
  },
  /** Switch the step on `line` off ("# off: " in front of it) or back on;
   *  `withCopies`: its mirrored copies follow. */
  suppressStep(code: string, line: number, off: boolean, withCopies = false): Promise<{ code: string }> {
    return request('/build/suppress_step', { method: 'POST',
      body: JSON.stringify({ code, line, off, ...(withCopies ? { copies: 'with' } : {}) }) });
  },
  /** Delete the step on `line`, and the P keys only it used. `copies`: what
   *  happens to its mirrored copies ('keep': they stay, unlinked). */
  deleteStep(code: string, line: number, copies?: 'keep' | 'delete'): Promise<{ code: string }> {
    return request('/build/delete_step', { method: 'POST', body: JSON.stringify({ code, line, ...(copies ? { copies } : {}) }) });
  },
  /** Append `part = mirror_body(part, PLANE, join=…)` (Separate: `, gap=…`, a
   *  number or an expression of P names), or rewrite the one on `line`. */
  addMirrorBody(payload: { code: string; plane: MirrorPlane; join: boolean; gap?: number | string; line?: number | null }): Promise<{ code: string }> {
    return request('/build/add_mirror_body', { method: 'POST', body: JSON.stringify(payload) });
  },
  /** One linked mirrored copy of each step on `lines`, after the last of them;
   *  `skipped`: the steps that can't be, and why. */
  mirrorSteps(code: string, lines: number[], plane: MirrorPlane):
    Promise<{ code: string; made: { of: number; line: number }[]; skipped: { line: number; reason: string }[] }> {
    return request('/build/mirror_steps', { method: 'POST', body: JSON.stringify({ code, lines, plane }) });
  },
  /** Append `part = pattern_body(part, PATTERN, join=…)`, or rewrite the one
   *  on `line`; `params`: the P keys holding the pattern's numbers. */
  addPatternBody(payload: { code: string; pattern: PatternSpec; join: boolean; line?: number | null }):
    Promise<{ code: string; params: string[] }> {
    return request('/build/add_pattern_body', { method: 'POST', body: JSON.stringify(payload) });
  },
  /** The copies in `pattern` of each step on `lines`, one linked line each
   *  after the last of them; `skipped`: the steps that can't be, and why. */
  patternSteps(code: string, lines: number[], pattern: PatternSpec):
    Promise<{ code: string; made: { of: number; line: number }[]; skipped: { line: number; reason: string }[]; params: string[] }> {
    return request('/build/pattern_steps', { method: 'POST', body: JSON.stringify({ code, lines, pattern }) });
  },
  /** The pattern of the copy on `line`, and of the copies made with it, rewritten. */
  setPattern(code: string, line: number, pattern: PatternSpec): Promise<{ code: string; params: string[] }> {
    return request('/build/set_pattern', { method: 'POST', body: JSON.stringify({ code, line, pattern }) });
  },
  /** Drop a mirrored or pattern copy's link comment: it no longer follows its original. */
  unlinkStep(code: string, line: number): Promise<{ code: string }> {
    return request('/build/unlink_step', { method: 'POST', body: JSON.stringify({ code, line }) });
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
  kind: 'edit' | 'question' | 'answer';
  code: string; note?: string; question: string;
  /** (kind 'answer') a reply to a question, the script unchanged */
  answer?: string;
  /** a change to the project brief the AI suggests; the user accepts or rejects it */
  brief_proposal?: { text: string; reason: string } | null;
  /** the spend, sent to staff only: all input read, cached or not; of it,
   *  cache_read_tokens came from the prompt cache */
  tokens_in?: number; tokens_out?: number; cost_usd?: number;
  cache_read_tokens?: number; cache_write_tokens?: number;
  /** the ids of the context files sent */
  context_files?: string[];
}

/** One AI call's spend. */
export interface CallSpend { tokens_in: number; tokens_out: number; cost_usd: number; cache_read_tokens?: number }

export interface UsageTotals {
  edits: number; tokens_in: number; tokens_out: number; cost_usd: number; cache_read_tokens?: number;
}

// ── context files (reference PDFs and images the AI reads) ──

export interface ContextFile {
  id: string;
  scope: 'part' | 'project';
  project_id: string | null;
  document_id: string | null;
  filename: string;
  title: string;
  note: string;
  content_type: string;
  size: number;
  page_count: number | null;
  width: number | null;
  height: number | null;
  in_context: boolean;
  /** 1-based pages sent to the AI; null = all */
  pages: number[] | null;
  page_tokens: number[];
  est_tokens: number;
  created_at: string;
}

export interface ContextFiles { part: ContextFile[]; project: ContextFile[]; project_id: string | null }

export type ContextOwner = { document: string } | { project: string };

const ownerQuery = (o: ContextOwner) =>
  'document' in o ? `document=${encodeURIComponent(o.document)}` : `project=${encodeURIComponent(o.project)}`;

export const contextApi = {
  list(owner: ContextOwner): Promise<ContextFiles> {
    return request(`/context/?${ownerQuery(owner)}`);
  },
  upload(owner: ContextOwner, file: File, note = ''): Promise<ContextFile> {
    const body = new FormData();
    body.append('file', file);
    if (note) body.append('note', note);
    return request(`/context/?${ownerQuery(owner)}`, { method: 'POST', body });
  },
  update(id: string, patch: { title?: string; note?: string; in_context?: boolean; pages?: number[];
                              all_pages?: boolean }): Promise<ContextFile> {
    return request(`/context/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  },
  remove(id: string): Promise<void> {
    return request(`/context/${id}`, { method: 'DELETE' });
  },
  /** an <img> URL for one page (the session cookie authenticates it) */
  thumbnailUrl(id: string, page = 1, width = 320): string {
    return `${API_BASE}/context/${id}/thumbnail?page=${page}&width=${width}`;
  },
  fileUrl(id: string): string {
    return `${API_BASE}/context/${id}/file`;
  },
};
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
  /** a cylindrical face: its axis (the way its ref has it, or the other) and the point on it level with its centre */
  axis?: [number, number, number]; axis_point?: [number, number, number];
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
export interface FaceRefReport {
  hint: string; status: 'found' | 'ambiguous' | 'not_found'; moved_by: number;
  /** edge_ref: the edge found — its length, middle and radius now — and the script line that looked it up */
  length?: number | null; midpoint?: [number, number, number] | null; radius?: number | null; line?: number | null;
}

/** An operation line read back (backend paramedit.op_at). Fillet and chamfer:
 *  args {edges: EdgeRefSpec[], size}, params {size: key}. Extrude: args
 *  {sketch, op, extent, depth, through, flip, both, datum, face, offset},
 *  params {depth: key}, exprs {offset} when it is an expression. */
export interface OpAt {
  op: OpKind; line: number; end_line: number;
  args: Record<string, unknown>;
  /** argument -> the P key holding it */
  params: Record<string, string>;
  /** argument -> its source, when written as an expression (shown, not edited) */
  exprs?: Record<string, string>;
  /** a mirrored copy (`mirrored(..., PLANE)`): across what, and the line of the
   *  step it follows (null: unlinked) */
  mirror?: { plane: MirrorPlane; label: string; of: number | null } | null;
  /** a pattern copy (`patterned(..., PATTERN)`): the pattern as written (its
   *  P keys and expressions), the step it follows (null: unlinked) and the
   *  copies made with it (their lines) */
  pattern?: { args: PatternSpec; params: Record<string, string>; exprs: Record<string, string>; label: string;
              of: number | null; lines: number[] } | null;
}

/** A pattern's direction (linear) or axis (circular): X / Y / Z, an edge (a
 *  straight edge: along it, or about it; a circular edge: its centre axis) or
 *  a face (a flat face's normal; a cylindrical face's axis). */
export type PatternDir = { base: 'X' | 'Y' | 'Z' } | { edge: EdgeRefSpec } | { face: FaceRefSpec };

/** A pattern as the API has it (backend paramedit._pattern_src). Each number
 *  may be an expression of P names. Instance 0 is the original; `skip` lists
 *  instances left out (in a grid, index = i + j·n1). */
export type PatternSpec =
  | { type: 'linear'; dir: PatternDir | null; count: number | string; mode: 'spacing' | 'extent';
      spacing?: number | string | null; extent?: number | string | null; symmetric?: boolean; flip?: boolean;
      dir2?: PatternDir | null; count2?: number | string; mode2?: 'spacing' | 'extent';
      spacing2?: number | string | null; extent2?: number | string | null; flip2?: boolean; skip?: number[] }
  | { type: 'circular'; axis: PatternDir | null; count: number | string; angle: number | string;
      symmetric?: boolean; flip?: boolean; skip?: number[] };

/** A pattern as the build laid it out (backend pattern._report), for the preview. */
export interface PatternReport {
  line?: number | null;
  what: 'body' | 'solid' | 'points' | 'edges' | 'faces';
  kind: 'linear' | 'circular';
  skip: number[];
  instances: { index: number; skip: boolean; center?: [number, number, number]; corners?: [number, number, number][] }[];
  /** linear: unit direction, spacing, count and instances along it (n1) */
  dir?: [number, number, number]; spacing?: number; count?: number; n1?: number; symmetric?: boolean;
  dir2?: [number, number, number]; spacing2?: number; count2?: number;
  /** circular: a point on the axis, the axis, the angle between instances */
  origin?: [number, number, number]; axis?: [number, number, number]; step?: number; angle?: number; full?: boolean;
}

/** A plane to mirror across, as the API has it (backend paramedit._plane_src). */
export type MirrorPlane = { base: 'XY' | 'XZ' | 'YZ' } | { plane: string } | { face: FaceRefSpec };

export type ExtrudeOp = 'cut' | 'join' | 'new';
/** How far an extrude goes: a depth, through the part (cut), up to the next
 *  face it meets (until="next") or up to a chosen face (until=face_ref). */
export type ExtrudeExtent = 'distance' | 'through' | 'next' | 'face';
export type ArgOpKind = 'auto_round' | 'truss_windows';
export type PlaneOpKind = 'offset_plane' | 'edge_plane' | 'tangent_plane';
export type OpKind = 'extrude' | 'revolve' | 'shell' | 'holes' | EdgeOpKind | ArgOpKind | PlaneOpKind | 'mirror_body' | 'pattern_body';

/** A construction plane as the build put it (backend modeling/planes.py). */
export interface PlaneReport {
  /** offset | edge | tangent | script (a Plane the script made itself) */
  kind: 'offset' | 'edge' | 'tangent' | 'script';
  /** from its face_ref / edge_ref */
  status: 'same' | 'moved' | 'ambiguous';
  line?: number | null;
  origin: [number, number, number];
  normal: [number, number, number];
  xAxis: [number, number, number];
  /** a tangent plane: its cylinder (`center` on the axis at the face's start
   *  end), what is 0° (`zero`), and whether it faces the axis (a bore) */
  cylinder?: { center: [number, number, number]; axis: [number, number, number]; radius: number;
               zero: [number, number, number]; length: number; inward: boolean };
}

/** An offset_plane()/edge_plane()/tangent_plane() line's values, for /build/add_plane. A
 *  distance or angle is a number, or an expression of P names ("-width / 2"). */
export type PlanePayload =
  | { op: 'offset_plane'; name: string; base: 'XY' | 'XZ' | 'YZ' | { face: FaceRefSpec }; distance: number | string }
  | { op: 'edge_plane'; name: string; edge: EdgeRefSpec; angle: number | string; from_face: FaceRefSpec | null }
  | { op: 'tangent_plane'; name: string; face: FaceRefSpec; angle: number | string;
      ref: 'X' | 'Y' | 'Z' | { face: FaceRefSpec } | null };

/** An auto_round keep item: as written (`src`), and the face_ref inside when it is one. */
export interface KeepItem { src?: string; ref?: FaceRefSpec | null }

/** A row of the steps list (backend paramedit.steps). */
export interface Step {
  kind: 'op' | 'script';
  line: number; end_line: number;
  /** 'script' on an op row: a switched-off line that isn't an operation */
  op?: OpKind | 'script' | null;
  variant?: ExtrudeOp | null;
  summary?: string | null;
  reopenable: boolean;
  off: boolean;
  /** a script run: its statements */
  count: number;
  sketch?: string | null;
  faces: FaceRefSpec[];
  edges: EdgeRefSpec[];
  /** a construction plane's name */
  plane?: string | null;
  /** a mirrored copy: the line of the step it follows, and the plane's label */
  mirror_of?: number | null;
  mirror_plane?: string | null;
  /** a pattern copy: the line of the step it follows, and its pattern in words */
  pattern_of?: number | null;
  pattern?: string | null;
}

/** An auto_round keep item's faces, as the part was when its line ran. */
export interface KeptFaces { line?: number | null; item: number; faces: FaceRefSpec[] }

export type EdgeOpKind = 'fillet' | 'chamfer';

export type HoleKind = 'clearance' | 'tapped' | 'insert' | 'counterbore' | 'countersink';
/** The preset sizes holes() can override, in mm. */
export type HoleSizeKey = 'd' | 'cbore_d' | 'cbore_depth' | 'csk_d';

/** A holes() line's values (backend paramedit.add_holes / op_at). */
export interface HolesPayload {
  at: { sketch: string } | { face: FaceRefSpec };
  kind: HoleKind;
  size: string;
  fit: 'close' | 'normal';
  depth: number | null;                                   // null: through
  standoff: { h: number; d: number; fillet: number } | null;
  sizes: Partial<Record<HoleSizeKey, number>>;            // only the presets changed
}

/** One hole preset (a row of backend hole_presets): diameters and depths in mm. */
export interface HolePreset {
  d: number; depth: number | null; standoff_d: number;
  cbore_d?: number; cbore_depth?: number; csk_d?: number; angle?: number;
  wall?: number; insert_d?: number; insert_l?: number;
}

export interface HolePresets {
  sizes: string[];
  kinds: HoleKind[];
  /** kind (and "clearance_close") -> size -> values */
  presets: Record<string, Record<string, HolePreset>>;
  standoff: { fillet: number; height: number };
}

export interface RunEdge {
  index: number; kind: string; faceIndices: number[]; polyline: [number, number, number][];
  /** edge_ref({...}): how a script line names it (none: a seam, or on one face only) */
  ref?: EdgeRefSpec | null;
}

/** edge_ref({...}): an edge, by the two faces it lies between (backend modeling/edge_ref.py). */
export interface EdgeRefSpec {
  faces: FaceRefSpec[];
  kind: string;
  midpoint: [number, number, number];
  length: number;
  /** a line */
  direction?: [number, number, number];
  /** a circle or arc */
  center?: [number, number, number]; radius?: number; axis?: [number, number, number];
  hint?: string;
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
  /** each edge_ref() lookup (moved_by: mm from where it was) */
  edge_refs?: FaceRefReport[];
  /** auto_round keep items, each item's faces */
  kept?: KeptFaces[];
  /** name -> each construction plane in PLANES */
  planes?: Record<string, PlaneReport>;
  /** each linear()/circular() the build used, its instances */
  patterns?: PatternReport[];
  /** each revolve() of a sketch: its axis, and where a profile crosses it */
  revolves?: import('@/build/revolve').RevolveReport[];
  /** the print bed face (the run's `bed`) found again: its index and outward normal now */
  bed?: { status: 'found' | 'ambiguous' | 'not_found'; face: number | null; normal: [number, number, number] | null } | null;
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
  warnings: { kind: string; message: string; at: number[]; line?: number | null }[];
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
