import type { CamTool, ClampZone, CutSide, DialSetting, PostProcessorSettings } from '@/types/cam';
import { DEFAULT_POST } from '@/types/cam';

/**
 * CAM settings in levels: a machine (with its tool library and its edits of the
 * material presets), the job's setup (stock, material, origin, clamps), and the
 * job's operations, which store only what was set on them. resolve.ts turns the
 * levels into the full per-operation parameters the toolpaths are built from.
 */

// ── Materials ──

export type MaterialId = 'birch-ply' | 'mdf' | 'hardwood' | 'acrylic' | 'aluminium-6061';

export const MATERIALS: { id: MaterialId; name: string }[] = [
  { id: 'birch-ply', name: 'Birch ply' },
  { id: 'mdf', name: 'MDF' },
  { id: 'hardwood', name: 'Hardwood' },
  { id: 'acrylic', name: 'Acrylic' },
  { id: 'aluminium-6061', name: 'Aluminium 6061' },
];

export const materialName = (id: MaterialId) => MATERIALS.find((m) => m.id === id)?.name ?? id;
export const isMaterial = (v: unknown): v is MaterialId => MATERIALS.some((m) => m.id === v);

// ── Machine ──

export type { ClampZone, DialSetting };

export type SpindleControl =
  | { kind: 'gcode' }
  | { kind: 'dial'; dial: DialSetting[] };

/** M0: pause for the operator. M6: a T… M6 tool change for the sender. ATC: an automatic changer. */
export type ToolChangeMethod = 'M0' | 'M6' | 'ATC';

/** What switches the coolant or dust extraction on: nothing, M7 (mist) or M8 (flood). */
export type CoolantOutput = 'none' | 'M7' | 'M8';

export interface LibraryTool {
  id: string;
  /** Tool number (T1, T2…), as on the rack and in M6 tool changes. */
  number: number;
  name: string;
  type: CamTool['type'];
  diameter: number;
  flutes: number;
  fluteLength: number;
  /** How far the tool sticks out of the collet. */
  stickout: number;
}

/** Cutting data for one tool in one material. Feed is never stored: it's chip load × flutes × rpm. */
export interface MaterialPreset {
  toolId: string;
  material: MaterialId;
  rpm: number;
  /** mm per tooth */
  chipLoad: number;
  depthPerPass: number;
  /** Fraction of the tool diameter. */
  stepover: number;
  /** Plunge feed as a percentage of the cutting feed. */
  plungePercent: number;
  /** Degrees from horizontal. */
  rampAngle: number;
}

export interface CamMachine {
  name: string;
  /** Controller and output format. */
  post: PostProcessorSettings;
  travel: { x: number; y: number; z: number };
  maxRpm: number;
  spindle: SpindleControl;
  /** G0 speed, mm/min (for time estimates; feeds are capped at it). */
  rapidRate: number;
  toolChange: ToolChangeMethod;
  /** Height above the stock top for moves between cuts. */
  safeZ: number;
  /** Height above the stock top for moves over clamps, tool changes and the end. */
  clearanceZ: number;
  /** Where to go for tool changes and at the end, in machine coordinates (G53), or null. */
  park: { x: number; y: number } | null;
  coolant: CoolantOutput;
  /** How far through cuts go below the stock, into the spoilboard. */
  spoilboardAllowance: number;
  tools: LibraryTool[];
  /** Presets the user edited; the others come from shippedPreset(). */
  presets: MaterialPreset[];
}

export const DEFAULT_TOOLS: LibraryTool[] = [
  { id: 't-3-flat', number: 1, name: '3 mm flat end mill', type: 'flat', diameter: 3, flutes: 2, fluteLength: 12, stickout: 20 },
  { id: 't-6-flat', number: 2, name: '6 mm flat end mill', type: 'flat', diameter: 6, flutes: 2, fluteLength: 22, stickout: 28 },
  { id: 't-1.5-flat', number: 3, name: '1.5 mm flat end mill', type: 'flat', diameter: 1.5, flutes: 2, fluteLength: 6, stickout: 15 },
  { id: 't-3-drill', number: 4, name: '3 mm drill', type: 'drill', diameter: 3, flutes: 2, fluteLength: 30, stickout: 35 },
];

export function createDefaultMachine(): CamMachine {
  return {
    name: 'Generic GRBL router',
    post: { ...DEFAULT_POST },
    travel: { x: 400, y: 400, z: 80 },
    maxRpm: 24000,
    spindle: { kind: 'gcode' },
    rapidRate: 3000,
    toolChange: 'M0',
    safeZ: 5,
    clearanceZ: 15,
    park: null,
    coolant: 'none',
    spoilboardAllowance: 0.3,
    tools: DEFAULT_TOOLS.map((t) => ({ ...t })),
    presets: [],
  };
}

/** A typical trim router's dial (Makita RT0700-style). */
export const TYPICAL_DIAL: DialSetting[] = [
  { setting: '1', rpm: 10000 },
  { setting: '2', rpm: 12000 },
  { setting: '3', rpm: 17000 },
  { setting: '4', rpm: 22000 },
  { setting: '5', rpm: 27000 },
  { setting: '6', rpm: 30000 },
];

// ── Shipped presets ──

interface MaterialData {
  /** Chip load per mm of tool diameter. */
  chipPerMm: number;
  rpm: number;
  /** Depth per pass as a share of the diameter. */
  docPerD: number;
  stepover: number;
  plungePercent: number;
  rampAngle: number;
}

const MATERIAL_DATA: Record<MaterialId, MaterialData> = {
  'birch-ply': { chipPerMm: 0.02, rpm: 18000, docPerD: 0.5, stepover: 0.45, plungePercent: 30, rampAngle: 5 },
  mdf: { chipPerMm: 0.025, rpm: 18000, docPerD: 0.6, stepover: 0.45, plungePercent: 30, rampAngle: 5 },
  hardwood: { chipPerMm: 0.016, rpm: 18000, docPerD: 0.4, stepover: 0.4, plungePercent: 25, rampAngle: 4 },
  acrylic: { chipPerMm: 0.02, rpm: 16000, docPerD: 0.4, stepover: 0.4, plungePercent: 30, rampAngle: 3 },
  'aluminium-6061': { chipPerMm: 0.008, rpm: 18000, docPerD: 0.15, stepover: 0.3, plungePercent: 20, rampAngle: 2 },
};

const round = (v: number, step: number) => Math.round(v / step) * step;
const tidy = (v: number) => Number(v.toFixed(4));

/** The shipped cutting data for a tool in a material: conservative figures for a hobby router. */
export function shippedPreset(tool: LibraryTool, material: MaterialId): MaterialPreset {
  const m = MATERIAL_DATA[material];
  const d = tool.diameter;
  // Drills and V-bits take half the chip of an end mill of the same size.
  const chipShare = tool.type === 'drill' || tool.type === 'vbit' ? 0.5 : 1;
  const chipLoad = tidy(Math.min(Math.max(round(m.chipPerMm * d * chipShare, 0.001), 0.005), 0.25));
  // A drill pecks one diameter at a time.
  const doc = tool.type === 'drill' ? d : Math.max(round(m.docPerD * d, 0.1), 0.1);
  return {
    toolId: tool.id,
    material,
    rpm: m.rpm,
    chipLoad,
    depthPerPass: tidy(Math.min(doc, tool.fluteLength)),
    stepover: m.stepover,
    plungePercent: m.plungePercent,
    rampAngle: m.rampAngle,
  };
}

/** The preset in use for a tool and material: the user's edit, else the shipped one. */
export function presetFor(tool: LibraryTool, material: MaterialId, presets: MaterialPreset[]): MaterialPreset {
  return presets.find((p) => p.toolId === tool.id && p.material === material) ?? shippedPreset(tool, material);
}

// ── Job setup ──

/** Points of the stock an origin can be on. Front is towards the operator (the bottom of the sketch). */
export type StockPoint =
  | 'front-left' | 'front-centre' | 'front-right'
  | 'centre'
  | 'back-left' | 'back-centre' | 'back-right';

export const STOCK_POINTS: StockPoint[] = [
  'back-left', 'back-centre', 'back-right', 'centre', 'front-left', 'front-centre', 'front-right',
];

export type JobOrigin =
  | { kind: 'stock'; point: StockPoint }
  | { kind: 'picked'; x: number; y: number };

export type ZZero = 'stock-top' | 'spoilboard';

export type SetupField = 'material' | 'width' | 'height' | 'thickness' | 'origin' | 'zZero' | 'clamps';

export interface CamJobSetup {
  /** The CamProfile holding the machine, or null for the built-in default. */
  machineId: string | null;
  material: MaterialId;
  /** Width and height null: the shapes' extent plus a margin. */
  stock: { width: number | null; height: number | null; thickness: number };
  origin: JobOrigin;
  zZero: ZZero;
  clamps: ClampZone[];
  selectedSketchIds: string[];
  /** Tools of this job only (from jobs saved before the tool library). */
  tools: LibraryTool[];
  /** Fields the AI filled in (shown violet until changed). */
  aiFields: SetupField[];
  /**
   * AI changes to the setup the user hasn't confirmed yet, with the values
   * from before them (so Undo can put them back). Run is blocked until
   * they're confirmed or undone.
   */
  aiPending?: SetupPrev;
  /** A G-code header and footer of the job's own, from jobs saved before machines had them. */
  legacyPost?: PostProcessorSettings;
}

/** Setup values as they were before an AI change. */
export interface SetupPrev {
  material?: MaterialId;
  thickness?: number;
  width?: number | null;
  height?: number | null;
  origin?: JobOrigin;
  zZero?: ZZero;
}

export function createDefaultSetup(): CamJobSetup {
  return {
    machineId: null,
    material: 'birch-ply',
    stock: { width: null, height: null, thickness: 6 },
    origin: { kind: 'stock', point: 'front-left' },
    zZero: 'stock-top',
    clamps: [],
    selectedSketchIds: [],
    tools: [],
    aiFields: [],
  };
}

// ── Operations ──

export type HoleMethod = 'drill' | 'helix';
export type Entry = 'plunge' | 'ramp';

/** Values set on an operation; anything missing comes from the levels above. */
export interface OpOverrides {
  toolId?: string;
  depth?: number;
  depthPerPass?: number;
  lastPassDepth?: number;
  rpm?: number;
  chipLoad?: number;
  plungePercent?: number;
  stepover?: number;
  entry?: Entry;
  rampAngle?: number;
  cutDirection?: 'climb' | 'conventional';
  tabs?: boolean;
  tabCount?: number;
  tabWidth?: number;
  tabHeight?: number;
  holeMethod?: HoleMethod;
  peckDepth?: number;
  dwell?: number;
}

export type OverrideKey = keyof OpOverrides;

export const OVERRIDE_KEYS: OverrideKey[] = [
  'toolId', 'depth', 'depthPerPass', 'lastPassDepth', 'rpm', 'chipLoad', 'plungePercent', 'stepover',
  'entry', 'rampAngle', 'cutDirection', 'tabs', 'tabCount', 'tabWidth', 'tabHeight', 'holeMethod',
  'peckDepth', 'dwell',
];

export type PlanKind = 'profile' | 'pocket' | 'drill' | 'facing';

export interface PlanOperation {
  id: string;
  kind: PlanKind;
  sketchId: string;
  entityIds: string[];
  /** Profile only. */
  cutSide: CutSide;
  /** AI or auto-plan proposals stay "proposed" until accepted. */
  status: 'proposed' | 'accepted';
  /** Why this operation (from the AI or the auto plan). */
  reason?: string;
  overrides: OpOverrides;
  /** Overrides the AI chose (shown violet until changed). */
  ai: OverrideKey[];
  /** An accepted operation the AI has since edited: how it was, for Reject. */
  aiPrev?: { overrides: OpOverrides; ai: OverrideKey[]; reason?: string };
}

export interface ChatTurn {
  role: 'user' | 'ai';
  text: string;
  choices?: string[];
  assumptions?: string[];
}

/** The saved job config (version 2). */
export interface CamJobV2 {
  version: 2;
  setup: CamJobSetup;
  operations: PlanOperation[];
  thread: ChatTurn[];
  /** What changed when an older job was brought over, shown once in Setup. */
  migrationNotes: string[];
}

export function createDefaultJob(): CamJobV2 {
  return { version: 2, setup: createDefaultSetup(), operations: [], thread: [], migrationNotes: [] };
}

let idCounter = 0;
export function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}
