import type { Point } from './document';

// ── Tool ──

export interface CamTool {
  id: string;
  name: string;
  diameter: number;
  type: 'flat' | 'ball' | 'vbit' | 'drill';
  fluteCount: number;
  fluteLength: number;
  /** Tool number on the machine (T1, T2…), for M6 tool changes. */
  number?: number;
}

// ── Stock ──

export interface Stock {
  thickness: number;
  zTop: number;
  /** Where the stock lies on the sketch (lowest corner, size), when known: facing with no shapes covers it. */
  area?: { x: number; y: number; width: number; height: number };
}

// ── Depth Strategy ──

export interface DepthSettings {
  totalDepth: number;
  depthPerPass: number;
  finalPassAllowance: number;
}

// ── Per-operation cutting parameters ──

export interface OperationCuttingParams {
  tool: CamTool;
  spindleSpeed: number;
  feedRate: number;
  plungeRate: number;
  safeZ: number;
  depth: DepthSettings;
}

// ── Operations ──

export type CutSide = 'inside' | 'outside' | 'on';

export interface ProfileOperation {
  kind: 'profile';
  entityIds: string[];
  sketchId: string;
  cutSide: CutSide;
  /** Climb or conventional milling (clockwise spindle). */
  cutDirection: 'climb' | 'conventional';
  /** Bridges left uncut on the deepest passes, to hold the part in the stock. */
  tabs: boolean;
  tabCount: number;
  tabWidth: number;
  tabHeight: number;
  /** Ramp into each pass along a closed path at this angle (degrees) instead of plunging. */
  rampAngle?: number;
  cutting: OperationCuttingParams;
}

export interface DrillOperation {
  kind: 'drill';
  entityIds: string[];
  sketchId: string;
  peckDepth: number;
  dwell: number;
  /** drill: plunge at the centre (a drill bit the hole's size). helix: bore it with a smaller end mill, spiralling down. */
  method?: 'drill' | 'helix';
  /** Helix only: the descent angle, degrees. */
  rampAngle?: number;
  cutting: OperationCuttingParams;
}

export interface PocketOperation {
  kind: 'pocket';
  entityIds: string[];
  sketchId: string;
  stepover: number;
  cutDirection: 'climb' | 'conventional';
  cutting: OperationCuttingParams;
}

export interface FacingOperation {
  kind: 'facing';
  entityIds: string[];
  sketchId: string;
  stepover: number;
  cutDirection: 'climb' | 'conventional';
  cutting: OperationCuttingParams;
}

export type CamOperation = ProfileOperation | DrillOperation | PocketOperation | FacingOperation;

// ── Post-Processor ──

export interface PostProcessorSettings {
  dialect: 'grbl';
  decimalPlaces: number;
  header: string;
  footer: string;
}

// ── Reusable Profile ──

export interface CamProfileConfig {
  cutting: OperationCuttingParams;
  postProcessor: PostProcessorSettings;
}

// ── Machine options and clamps ──

/** One position of a router's speed dial and the speed it gives. */
export interface DialSetting { setting: string; rpm: number }

/** How the G-code handles the parts of the machine that resolve.ts takes from the machine settings. */
export interface JobMachineOptions {
  /** Height above the stock top for the start, tool changes, the end, and moves over clamps. */
  clearanceZ: number;
  /** Machine coordinates (G53) to go to for tool changes and at the end, or null for X0 Y0. */
  park: { x: number; y: number } | null;
  /** M0: pause for the operator. M6: T… M6 for the sender or controller. ATC: T… M6, no pause. */
  toolChange: 'M0' | 'M6' | 'ATC';
  coolant: 'none' | 'M7' | 'M8';
  /** A router with a speed dial: the operator is asked to set it. Null: the spindle takes S. */
  dial: DialSetting[] | null;
  /** How far a through cut may go past the bottom of the stock; deeper is an error. Unset: deeper only warns. */
  spoilboardAllowance?: number;
}

/** An area the tool keeps out of: a clamp, as a rectangle on the sketch (top-left x, y), standing zHeight above the stock top. */
export interface ClampZone {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zHeight: number;
}

// ── Job Config ──

export interface CamJobConfig {
  profileId: string | null;
  stock: Stock;
  postProcessor: PostProcessorSettings;
  useFloodCoolant: boolean;
  selectedSketchIds: string[];
  operations: CamOperation[];
  origin: Point;
  /** Set when built from machine settings (resolve.ts); older configs use safe Z for everything. */
  machine?: JobMachineOptions;
  clamps?: ClampZone[];
}

// ── Validation ──

export type CamIssueSeverity = 'error' | 'warning' | 'info';

export interface CamIssue {
  severity: CamIssueSeverity;
  message: string;
  operationIndex?: number;
  entityId?: string;
  position?: Point;
}

// ── Intermediate Toolpath Representation ──

export interface LinearMove {
  kind: 'linear';
  to: Point;
  z: number;
  feed: number;
}

export interface ArcMove {
  kind: 'arc';
  to: Point;
  z: number;
  /** Arc centre relative to the move's start point (I, J), in sketch coordinates. */
  center: Point;
  /** Clockwise as seen on screen, which is also clockwise seen from above the
   *  machine (Y up): the sketch is Y down, and the G-code flips Y, so the two
   *  views match. G2 when true, G3 when false. */
  clockwise: boolean;
  feed: number;
}

export interface RapidMove {
  kind: 'rapid';
  to: Point;
  z: number;
}

/** Stay where the tool is for a time (G4). `to` and `z` are the current position. */
export interface DwellMove {
  kind: 'dwell';
  to: Point;
  z: number;
  seconds: number;
}

export type ToolpathMove = LinearMove | ArcMove | RapidMove | DwellMove;

// ── Server response types ──

export interface CamProfileSummary {
  id: string;
  name: string;
  updated_at: string;
}

export interface CamJobSummary {
  id: string;
  name: string;
  document_id: string;
  updated_at: string;
  has_gcode: boolean;
  error_count: number;
}

// ── Defaults ──

export const DEFAULT_TOOL: CamTool = {
  id: 'default-3mm',
  name: '3mm Flat End Mill',
  diameter: 3,
  type: 'flat',
  fluteCount: 2,
  fluteLength: 12,
};

export const DEFAULT_DEPTH: DepthSettings = {
  totalDepth: 3,
  depthPerPass: 1,
  finalPassAllowance: 0,
};

export const DEFAULT_CUTTING: OperationCuttingParams = {
  tool: { ...DEFAULT_TOOL },
  spindleSpeed: 12000,
  feedRate: 800,
  plungeRate: 200,
  safeZ: 5,
  depth: { ...DEFAULT_DEPTH },
};

export const DEFAULT_POST: PostProcessorSettings = {
  dialect: 'grbl',
  decimalPlaces: 3,
  header: '',
  footer: '',
};

export const DEFAULT_STOCK: Stock = {
  thickness: 3,
  zTop: 0,
};

export function createDefaultCutting(): OperationCuttingParams {
  return {
    tool: { ...DEFAULT_TOOL },
    spindleSpeed: 12000,
    feedRate: 800,
    plungeRate: 200,
    safeZ: 5,
    depth: { ...DEFAULT_DEPTH },
  };
}

export function createDefaultJobConfig(): CamJobConfig {
  return {
    profileId: null,
    stock: { ...DEFAULT_STOCK },
    postProcessor: { ...DEFAULT_POST },
    useFloodCoolant: false,
    selectedSketchIds: [],
    operations: [],
    origin: { x: 0, y: 0 },
  };
}

// ── Migration ──

/** Migrate old job configs that had global tool/machine/depth to per-operation cutting. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function migrateCamJobConfig(raw: any): CamJobConfig {
  if (!raw || typeof raw !== 'object') return createDefaultJobConfig();

  // Detect old format: has top-level 'tool' or 'machine' fields
  if (raw.tool || raw.machine) {
    const oldTool = raw.tool ?? DEFAULT_TOOL;
    const oldMachine = raw.machine ?? {};
    const oldDepth = raw.depth ?? DEFAULT_DEPTH;

    const cutting: OperationCuttingParams = {
      tool: { ...DEFAULT_TOOL, ...oldTool },
      spindleSpeed: oldMachine.spindleSpeed ?? 12000,
      feedRate: oldMachine.feedRate ?? 800,
      plungeRate: oldMachine.plungeRate ?? 200,
      safeZ: oldMachine.safeZ ?? 5,
      depth: { ...DEFAULT_DEPTH, ...oldDepth },
    };

    const operations = Array.isArray(raw.operations)
      ? raw.operations.map((op: CamOperation) => ({
          ...op,
          cutting: (op as unknown as { cutting?: OperationCuttingParams }).cutting ?? { ...cutting, tool: { ...cutting.tool }, depth: { ...cutting.depth } },
        }))
      : [];

    return normalise({
      profileId: raw.profileId ?? null,
      stock: raw.stock ?? { ...DEFAULT_STOCK },
      postProcessor: raw.postProcessor ?? { ...DEFAULT_POST },
      useFloodCoolant: oldMachine.useFloodCoolant ?? false,
      selectedSketchIds: raw.selectedSketchIds ?? [],
      operations,
      origin: raw.origin ?? { x: 0, y: 0 },
    });
  }

  return normalise(raw as CamJobConfig);
}

/** Fill in settings added since a job was saved, and drop ones that are gone. */
function normalise(config: CamJobConfig): CamJobConfig {
  // Arcs are always written as G2/G3 now (GRBL interpolates them itself).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { arcOutput, linearizeTolerance, ...post } = (config.postProcessor ?? DEFAULT_POST) as PostProcessorSettings & {
    arcOutput?: unknown;
    linearizeTolerance?: unknown;
  };
  return {
    ...config,
    postProcessor: { ...DEFAULT_POST, ...post },
    operations: (config.operations ?? []).map((op) =>
      op.kind === 'profile'
        ? { ...op, cutDirection: op.cutDirection ?? 'climb', tabCount: op.tabCount ?? 4 }
        : op),
  };
}

// ── Normalising configs from outside (saved jobs, AI suggestions) ──

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const positive = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);

/** Fill a possibly partial cutting block from defaults, so every field the UI reads exists. */
export function normalizeCutting(raw: unknown, base: OperationCuttingParams = createDefaultCutting()): OperationCuttingParams {
  const r = isObj(raw) ? raw : {};
  const tool = isObj(r.tool) ? r.tool : {};
  const depth = isObj(r.depth) ? r.depth : {};
  const toolType = ['flat', 'ball', 'vbit', 'drill'].includes(tool.type as string)
    ? (tool.type as CamTool['type']) : base.tool.type;
  return {
    tool: {
      id: typeof tool.id === 'string' ? tool.id : base.tool.id,
      name: typeof tool.name === 'string' ? tool.name : base.tool.name,
      diameter: num(tool.diameter, base.tool.diameter),
      type: toolType,
      fluteCount: num(tool.fluteCount, base.tool.fluteCount),
      fluteLength: num(tool.fluteLength, base.tool.fluteLength),
    },
    spindleSpeed: num(r.spindleSpeed, base.spindleSpeed),
    feedRate: num(r.feedRate, base.feedRate),
    plungeRate: num(r.plungeRate, base.plungeRate),
    safeZ: num(r.safeZ, base.safeZ),
    depth: {
      totalDepth: num(depth.totalDepth, base.depth.totalDepth),
      depthPerPass: num(depth.depthPerPass, base.depth.depthPerPass),
      finalPassAllowance: num(depth.finalPassAllowance, base.depth.finalPassAllowance),
    },
  };
}

/**
 * Turn one operation from outside into a complete CamOperation, or null when
 * its kind is unknown. Entity ids are kept only when `knownIds` has them.
 */
export function normalizeOperation(
  raw: unknown,
  fallbackSketchId: string,
  knownIds?: Set<string>,
  baseCutting?: OperationCuttingParams,
): CamOperation | null {
  if (!isObj(raw)) return null;
  const ids = Array.isArray(raw.entityIds) ? raw.entityIds.filter((id): id is string => typeof id === 'string') : [];
  const common = {
    entityIds: knownIds ? ids.filter((id) => knownIds.has(id)) : ids,
    sketchId: typeof raw.sketchId === 'string' && raw.sketchId ? raw.sketchId : fallbackSketchId,
    cutting: normalizeCutting(raw.cutting, baseCutting),
  };
  const dir = raw.cutDirection === 'conventional' ? 'conventional' as const : 'climb' as const;
  switch (raw.kind) {
    case 'profile':
      return {
        ...common, kind: 'profile',
        cutSide: raw.cutSide === 'inside' || raw.cutSide === 'on' ? raw.cutSide : 'outside',
        cutDirection: dir,
        tabs: raw.tabs === true,
        tabCount: Number.isInteger(raw.tabCount) && (raw.tabCount as number) >= 1 ? raw.tabCount as number : 4,
        tabWidth: positive(raw.tabWidth, 5),
        tabHeight: positive(raw.tabHeight, 1),
      };
    case 'pocket':
      return { ...common, kind: 'pocket', stepover: num(raw.stepover, 0.4), cutDirection: dir };
    case 'facing':
      return { ...common, kind: 'facing', stepover: num(raw.stepover, 0.4), cutDirection: dir };
    case 'drill':
      return { ...common, kind: 'drill', peckDepth: num(raw.peckDepth, 0), dwell: num(raw.dwell, 0) };
    default:
      return null;
  }
}

/** A saved job config, migrated and with every operation complete. */
export function normalizeCamJobConfig(raw: unknown): CamJobConfig {
  const migrated = migrateCamJobConfig(raw);
  const base = createDefaultJobConfig();
  const sketchIds = Array.isArray(migrated.selectedSketchIds) ? migrated.selectedSketchIds : [];
  const ops = Array.isArray(migrated.operations) ? migrated.operations : [];
  return {
    ...base,
    ...migrated,
    stock: { ...base.stock, ...(isObj(migrated.stock) ? migrated.stock : {}) },
    postProcessor: { ...base.postProcessor, ...(isObj(migrated.postProcessor) ? migrated.postProcessor : {}) },
    origin: isObj(migrated.origin) ? migrated.origin as unknown as CamJobConfig['origin'] : base.origin,
    selectedSketchIds: sketchIds,
    operations: ops
      .map((op) => normalizeOperation(op, sketchIds[0] ?? ''))
      .filter((op): op is CamOperation => op !== null),
  };
}

export interface AppliedSuggestion {
  config: CamJobConfig;
  /** What was dropped or changed, for the log. */
  notes: string[];
}

/**
 * Apply an AI-suggested config to the current job. The suggestion may use the
 * old format (tool and feeds at the top level). Only operations, stock and
 * coolant are taken from it; sketches, origin, profile and the post-processor
 * stay as the user set them. Operations must name entities that exist.
 */
export function applyCamSuggestion(current: CamJobConfig, raw: unknown, knownIds: Set<string>): AppliedSuggestion {
  const notes: string[] = [];
  const r = isObj(raw) ? raw : {};
  // Old format: one tool / machine / depth for every operation.
  const machine = isObj(r.machine) ? r.machine : {};
  const shared = normalizeCutting({ ...machine, tool: r.tool, depth: r.depth });
  const fallbackSketch = current.selectedSketchIds[0] ?? '';

  const rawOps = Array.isArray(r.operations) ? r.operations : [];
  const operations: CamOperation[] = [];
  for (const rawOp of rawOps) {
    const op = normalizeOperation(rawOp, fallbackSketch, knownIds, shared);
    if (!op) {
      notes.push('Skipped a suggested operation of an unknown kind');
      continue;
    }
    if (op.entityIds.length === 0 && op.kind !== 'facing') {
      notes.push(`Skipped a suggested ${op.kind} operation: it named no shapes in the selected sketches`);
      continue;
    }
    operations.push(op);
  }

  const stock = isObj(r.stock) ? r.stock : {};
  const coolant = isObj(r.machine) && typeof r.machine.useFloodCoolant === 'boolean'
    ? r.machine.useFloodCoolant
    : typeof r.useFloodCoolant === 'boolean' ? r.useFloodCoolant : current.useFloodCoolant;

  return {
    config: {
      ...current,
      stock: { thickness: num(stock.thickness, current.stock.thickness), zTop: current.stock.zTop },
      useFloodCoolant: coolant,
      operations: operations.length > 0 ? operations : current.operations,
    },
    notes: operations.length > 0 ? notes : [...notes, 'No usable operations in the suggestion; kept your operations'],
  };
}
