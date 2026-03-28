import type { Point } from './document';

// ── Tool ──

export interface CamTool {
  id: string;
  name: string;
  diameter: number;
  type: 'flat' | 'ball' | 'vbit' | 'drill';
  fluteCount: number;
  fluteLength: number;
}

// ── Stock ──

export interface Stock {
  thickness: number;
  zTop: number;
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
  tabs: boolean;
  tabWidth: number;
  tabHeight: number;
  cutting: OperationCuttingParams;
}

export interface DrillOperation {
  kind: 'drill';
  entityIds: string[];
  sketchId: string;
  peckDepth: number;
  dwell: number;
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
  arcOutput: 'arcs' | 'linearize';
  linearizeTolerance: number;
  header: string;
  footer: string;
}

// ── Reusable Profile ──

export interface CamProfileConfig {
  cutting: OperationCuttingParams;
  postProcessor: PostProcessorSettings;
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
  center: Point;
  clockwise: boolean;
  feed: number;
}

export interface RapidMove {
  kind: 'rapid';
  to: Point;
  z: number;
}

export type ToolpathMove = LinearMove | ArcMove | RapidMove;

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
  arcOutput: 'arcs',
  linearizeTolerance: 0.01,
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

    return {
      profileId: raw.profileId ?? null,
      stock: raw.stock ?? { ...DEFAULT_STOCK },
      postProcessor: raw.postProcessor ?? { ...DEFAULT_POST },
      useFloodCoolant: oldMachine.useFloodCoolant ?? false,
      selectedSketchIds: raw.selectedSketchIds ?? [],
      operations,
      origin: raw.origin ?? { x: 0, y: 0 },
    };
  }

  return raw as CamJobConfig;
}
