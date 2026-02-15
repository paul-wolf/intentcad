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

// ── Stock & Machine ──

export interface Stock {
  thickness: number;
  zTop: number;
}

export interface MachineSetup {
  spindleSpeed: number;
  feedRate: number;
  plungeRate: number;
  safeZ: number;
  useFloodCoolant: boolean;
}

// ── Depth Strategy ──

export interface DepthSettings {
  totalDepth: number;
  depthPerPass: number;
  finalPassAllowance: number;
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
}

export interface DrillOperation {
  kind: 'drill';
  entityIds: string[];
  sketchId: string;
  peckDepth: number;
  dwell: number;
}

export interface PocketOperation {
  kind: 'pocket';
  entityIds: string[];
  sketchId: string;
  stepover: number;
  cutDirection: 'climb' | 'conventional';
}

export type CamOperation = ProfileOperation | DrillOperation | PocketOperation;

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
  tool: CamTool;
  machine: MachineSetup;
  postProcessor: PostProcessorSettings;
}

// ── Job Config ──

export interface CamJobConfig {
  profileId: string | null;
  tool: CamTool;
  machine: MachineSetup;
  stock: Stock;
  depth: DepthSettings;
  postProcessor: PostProcessorSettings;
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

export const DEFAULT_MACHINE: MachineSetup = {
  spindleSpeed: 12000,
  feedRate: 800,
  plungeRate: 200,
  safeZ: 5,
  useFloodCoolant: false,
};

export const DEFAULT_DEPTH: DepthSettings = {
  totalDepth: 3,
  depthPerPass: 1,
  finalPassAllowance: 0,
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

export function createDefaultJobConfig(): CamJobConfig {
  return {
    profileId: null,
    tool: { ...DEFAULT_TOOL },
    machine: { ...DEFAULT_MACHINE },
    stock: { ...DEFAULT_STOCK },
    depth: { ...DEFAULT_DEPTH },
    postProcessor: { ...DEFAULT_POST },
    selectedSketchIds: [],
    operations: [],
    origin: { x: 0, y: 0 },
  };
}
