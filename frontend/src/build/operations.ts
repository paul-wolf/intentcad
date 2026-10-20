/**
 * The part editor's operations, in one list. The Operations layout's grid,
 * the slim top bar (the `pinned` ones) and the single-key shortcuts all come
 * from here. Each operation says what it needs — from the selected faces and
 * the state of the model — with the reason in words when it can't run, and
 * runs through the editor's own actions (OpContext), so a tile, a top-bar
 * button and a key do exactly the same thing.
 *
 * Pure: no React, no DOM — the icons are named here and drawn by OpIcons.
 */
import type { StandardView } from './viewOrient';
import type { BasePlane } from './faceSketch';
import { FILTER_KEY } from './edgePick';

export type OpGroup = 'Sketch' | 'Create' | 'Modify' | 'Pattern' | 'Inspect' | 'View' | 'File';
/** The order the groups are shown in (an empty one isn't shown: the part
 *  editor has no pattern operations yet — grid and circular copy are the 2D
 *  sketcher's). */
export const OP_GROUPS: OpGroup[] = ['Sketch', 'Create', 'Modify', 'Pattern', 'Inspect', 'View', 'File'];

export type OpIcon =
  | 'sketch-face' | 'plane-top' | 'plane-front' | 'plane-right' | 'extrude' | 'hole' | 'shell' | 'fillet' | 'chamfer' | 'round'
  | 'lighten' | 'protect' | 'fix' | 'measure' | 'section' | 'normal' | 'ortho' | 'params' | 'build' | 'import'
  | 'export' | 'stl' | 'parts' | 'dxf' | 'views3' | 'versions' | 'process' | 'context'
  | `view-${StandardView}`;

/** What's selected: the faces and the edges, in the order they were picked. */
export interface OpSelection {
  faces: { kind: string }[];
  edges: { kind: string }[];
}

/** The state of the model the operations depend on. */
export interface OpModel {
  status: 'idle' | 'building' | 'done' | 'error';
  /** the script isn't empty */
  hasCode: boolean;
  /** a Shell, Hole, Fillet or Chamfer dialog is open */
  dialogOpen: boolean;
  /** the face sketcher is open */
  sketching: boolean;
  /** sketching is offered here (not when the part editor is over the 2D editor) */
  canSketch: boolean;
  /** the AI is working on a change */
  asking: boolean;
  /** face sketches with points or circles to put holes at */
  holeSketches: number;
  /** where Hole would put the holes, in words (with a flat face selected) */
  holeAt: string | null;
  /** the build ran auto_round */
  autoRound: boolean;
  exporting: boolean;
  importing: boolean;
  hasParams: boolean;
  showParams: boolean;
  ortho: boolean;
  /** the measure readout for the selection, in words (null: nothing to measure) */
  measure: string | null;
  /** the section view is on */
  section: boolean;
}

export type ExportFormat = 'stl' | 'step' | 'stl-parts' | 'dxf' | 'dxf-views';

/** The editor's actions the operations run. */
export interface OpContext {
  /** K: sketch on the selected flat face (nothing selected: the plane menu) */
  sketchOnSelection(): void;
  sketchOnPlane(which: BasePlane): void;
  shell(): void;
  hole(): void;
  /** the Fillet / Chamfer dialog, on the selected edges */
  fillet(): void;
  chamfer(): void;
  /** send an instruction to the AI (as the Ask box does) */
  ask(instruction: string): void;
  /** build — or, while a build runs, cancel it */
  build(): void;
  importStep(): void;
  exportAs(format: ExportFormat): void;
  versions(): void;
  process(): void;
  /** the Context layout, and the file picker for a reference PDF or photo */
  addContextFile(): void;
  toggleParams(): void;
  setView(view: StandardView): void;
  lookAtSelection(): void;
  toggleOrtho(): void;
  copyMeasure(): void;
  /** Z: the section view on (or off) */
  section(): void;
}

export type Need = { ok: true } | { ok: false; reason: string };

export interface Operation {
  id: string;
  name: string;
  group: OpGroup;
  icon: OpIcon;
  /** one line, for the tile's tooltip and the top bar */
  help: string;
  /** two to four sentences, for the help card */
  longHelp: string;
  /** the key that runs it ('K T': K, then T) */
  shortcut?: string;
  /** what to ask the AI instead ("or ask: …") */
  example: string;
  needs(sel: OpSelection, m: OpModel): Need;
  run(ctx: OpContext): void;
  /** shown in the slim top bar */
  pinned?: boolean;
  /** the name to show now, when it changes with the state (Build → Cancel build) */
  label?(m: OpModel): string;
  /** a live line on an enabled tile (what it will do with this selection) */
  detail?(sel: OpSelection, m: OpModel): string | null;
}

// The instructions the AI buttons send.
/** "Fix with AI" on a failed build: the error travels as `build_error` context. */
export const FIX_INSTRUCTION = 'Fix the build error, keeping the design intent.';
/** "Protect" on a face selection: the selection travels as context. */
export const PROTECT_INSTRUCTION = "Add the selected face(s) to auto_round's keep list with a robust selector, change nothing else.";
/** "Lighten": the organic-shapes design pattern from the system prompt, so it
 *  can be reached without knowing what to ask for. */
export const LIGHTEN_INSTRUCTION = 'Make this part lighter and more organic: aim to remove 30-40% of its mass. '
  + 'Keep every hole, boss and mating face exact. '
  + 'Lighten its flat plates with truss_windows() anchored at the mounts, sized to hit that target '
  + '(only the selected face, if one is selected), '
  + 'or, if it is an open bracket, rebuild it as a frame() of tapered, gently bowed members between the mount points. '
  + 'Then auto_round() last.';
/** "Round": auto_round on its own. */
export const ROUND_INSTRUCTION = 'Round every edge of this part with auto_round() as the last line, with the convex and '
  + 'concave radii as P["round_r"] and P["blend_r"] sized to suit the part. Keep holes and mating faces exact '
  + '(and the selected face, if one is selected). If the script already calls auto_round, leave it in place and '
  + 'only fix what stops it rounding.';

const OK: Need = { ok: true };
const no = (reason: string): Need => ({ ok: false, reason });
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** The first reason in the list that applies, else OK. */
function first(...checks: [boolean, string][]): Need {
  for (const [bad, reason] of checks) if (bad) return no(reason);
  return OK;
}
const notWhile = (m: OpModel): [boolean, string][] => [
  [m.sketching, 'Finish the sketch first'],
  [m.dialogOpen, 'Close the open dialog first'],
];
const built = (m: OpModel): [boolean, string][] => [
  [m.status === 'building', 'Wait for the build'],
  [m.status !== 'done', m.status === 'error' ? 'Fix the build first' : 'Build the part first'],
];
const oneFlatFace = (sel: OpSelection): [boolean, string][] => [
  [sel.faces.length === 0, 'Select a flat face'],
  [sel.faces.length > 1, 'Select just one flat face'],
  [sel.faces[0]?.kind !== 'plane', 'Select a flat face, not a curved one'],
];
const aiFree = (m: OpModel): [boolean, string][] => [
  [!m.hasCode, 'Start a part first'],
  [m.asking, 'The AI is working on a change'],
  [m.status === 'building', 'Wait for the build'],
];

const EDGES_REASON = 'Select edges (double-click for a whole loop)';

const SKETCH_PLANES: [BasePlane, string, string][] = [
  ['top', 'Top', 'T'], ['front', 'Front', 'F'], ['right', 'Right', 'R'],
];

const VIEW_OPS: [StandardView, string, string][] = [
  ['front', 'Front', '1'], ['back', 'Back', '2'], ['left', 'Left', '3'], ['right', 'Right', '4'],
  ['top', 'Top', '5'], ['bottom', 'Bottom', '6'], ['iso', 'Iso', '0'],
];

const EXPORTS: [ExportFormat, string, OpIcon, string, string][] = [
  ['stl', 'Export STL', 'stl', 'Download the part as STL, for printing',
   'Downloads the part as one STL mesh, the format slicers read. Holes and curves are made of small triangles, '
   + 'fine enough for printing.'],
  ['step', 'Export STEP', 'export', 'Download the part as STEP, for other CAD tools',
   'Downloads the part as a STEP solid: exact faces and edges that other CAD tools (Fusion, Onshape, FreeCAD) '
   + 'can edit and measure. Choose it over STL when the part goes on to be changed or machined.'],
  ['stl-parts', 'Export parts', 'parts', 'One STL per body, zipped (for printing an assembly)',
   'Downloads a zip with one STL for each separate body of the part. Each can then be placed and oriented on the '
   + 'bed on its own.'],
  ['dxf', 'Export DXF', 'dxf', 'Flat top-down outline as DXF, for 2D CAM / CNC routing',
   'Downloads the outline of the part seen from above as a DXF drawing, for laser cutting, CNC routing or '
   + '2D CAM. Export 3 views adds the front and the side.'],
  ['dxf-views', 'Export 3 views', 'views3', 'Top, front and side outlines as three DXF files, zipped',
   'Downloads a zip of three DXF drawings: the part seen from the top, the front and the side. Together they make '
   + 'a quick workshop drawing.'],
];

export const OPERATIONS: Operation[] = [
  // Sketch
  {
    id: 'sketch-face', name: 'Sketch on face', group: 'Sketch', icon: 'sketch-face', shortcut: 'K', pinned: true,
    help: 'Open the 2D sketcher on the selected flat face',
    longHelp: 'Opens the full 2D sketcher on the selected flat face, with the face\'s edges drawn as references '
      + 'to dimension to. Esc or Done returns to 3D; the sketch stays drawn on the part and follows its face when '
      + 'the part changes. A face that has sketches already offers them, or a new one.',
    example: 'cut a 20 × 10 mm slot in the middle of this face',
    needs: (sel, m) => first([!m.canSketch, 'Sketching is in the part editor on its own page'], ...notWhile(m),
                             ...oneFlatFace(sel)),
    run: (ctx) => ctx.sketchOnSelection(),
  },
  ...SKETCH_PLANES.map(([which, name, key]): Operation => ({
    id: `sketch-${which}`, name: `Sketch on ${name}`, group: 'Sketch', icon: `plane-${which}` as OpIcon,
    shortcut: `K ${key}`,
    help: `Sketch on the ${name.toLowerCase()} plane through the origin`,
    longHelp: `Opens the 2D sketcher on the ${name} plane through the origin (${
      { top: 'XY', front: 'XZ', right: 'YZ' }[which]}), reopening its sketch if there is one. This is how a new `
      + 'part starts: sketch the outline, then Extrude → New body. With nothing selected, K and then '
      + `${key} does the same.`,
    example: which === 'top' ? 'start a 60 × 40 mm plate, 5 mm thick' : `add a rib on the ${name.toLowerCase()} plane`,
    needs: (_sel, m) => first([!m.canSketch, 'Sketching is in the part editor on its own page'], ...notWhile(m)),
    run: (ctx) => ctx.sketchOnPlane(which),
  })),
  // Create
  {
    id: 'extrude', name: 'Extrude', group: 'Create', icon: 'extrude',
    help: 'Sketch on the selected face, then Extrude… cuts or grows the shapes',
    longHelp: 'Extrude works on a sketch: this opens the sketcher on the selected flat face. Draw closed shapes, '
      + 'then Extrude… in the sketch bar cuts them into the part (through or to a depth) or joins them on, with '
      + 'a preview of the way it goes. To start a new part, sketch on the Top plane instead.',
    example: 'extrude a 10 mm boss on this face',
    needs: (sel, m) => first([!m.canSketch, 'Sketching is in the part editor on its own page'], ...notWhile(m),
                             ...oneFlatFace(sel)),
    run: (ctx) => ctx.sketchOnSelection(),
  },
  {
    id: 'hole', name: 'Hole', group: 'Create', icon: 'hole', pinned: true,
    help: 'Screw holes at a sketch\'s points or a flat face\'s centre',
    longHelp: 'Screw holes straight into the part: clearance, tapped, heat-set insert, counterbore or '
      + 'countersink, M2–M5, optionally in standoffs. They go at the points and circle centres of the sketch on the '
      + 'selected face, or at its centre. A blue ghost previews the result; it adds one script line.',
    example: 'four M3 insert standoffs 6 high at the sketch points',
    needs: (sel, m) => {
      const base = first(...notWhile(m), ...built(m));
      if (!base.ok) return base;
      if (sel.faces.length === 1 && sel.faces[0]!.kind === 'plane') return OK;
      if (m.holeSketches > 0) return OK;   // at a sketch's points, picked in the dialog
      return first(...oneFlatFace(sel));
    },
    detail: (sel, m) => (sel.faces.length === 1 && sel.faces[0]!.kind === 'plane' ? m.holeAt
      : m.holeSketches > 0 ? 'at a sketch\'s points' : null),
    run: (ctx) => ctx.hole(),
  },
  // Modify
  {
    id: 'shell', name: 'Shell', group: 'Modify', icon: 'shell', pinned: true,
    help: 'Hollow the part to walls, leaving the selected faces open',
    longHelp: 'Hollows the part out to walls of a thickness, leaving the selected faces open (Shift-click to '
      + 'select more). In the dialog: the thickness, inside or outside, and the open faces — click a face of the '
      + 'part to add or drop one. A blue ghost previews the result; it adds one script line.',
    example: 'shell it, 2 mm walls, open top',
    needs: (sel, m) => first(...notWhile(m), ...built(m), [sel.faces.length === 0, 'Select the faces to remove']),
    detail: (sel) => `${plural(sel.faces.length, 'face')} left open`,
    run: (ctx) => ctx.shell(),
  },
  {
    id: 'fillet', name: 'Fillet', group: 'Modify', icon: 'fillet', pinned: true,
    help: 'Round the selected edges to a radius',
    longHelp: 'Rounds the selected edges to a radius (double-click an edge for its whole loop, Shift-click for '
      + 'more). In the dialog: the radius — type it or drag the handle on the first edge — and the edges: click '
      + 'one in the view to add or drop it. A blue ghost previews the result; it adds one script line, which '
      + 'double-clicking reopens.',
    example: 'fillet the top rim 1 mm',
    needs: (sel, m) => first(...notWhile(m), ...built(m), [sel.edges.length === 0, EDGES_REASON]),
    detail: (sel) => `${plural(sel.edges.length, 'edge')} rounded`,
    run: (ctx) => ctx.fillet(),
  },
  {
    id: 'chamfer', name: 'Chamfer', group: 'Modify', icon: 'chamfer',
    help: 'Bevel the selected edges, a distance back along each face',
    longHelp: 'Bevels the selected edges at 45°, cutting a distance back along each face — on the bottom edges, '
      + 'the relief for a 3D print\'s elephant\'s foot. The dialog works as Fillet\'s: the distance (or drag the '
      + 'handle), the edges, a blue ghost preview, one script line.',
    example: 'chamfer the bottom edges 0.6 mm',
    needs: (sel, m) => first(...notWhile(m), ...built(m), [sel.edges.length === 0, EDGES_REASON]),
    detail: (sel) => `${plural(sel.edges.length, 'edge')} bevelled`,
    run: (ctx) => ctx.chamfer(),
  },
  {
    id: 'round', name: 'Round', group: 'Modify', icon: 'round', pinned: true,
    help: 'AI: round every edge, keeping holes and mating faces exact',
    longHelp: 'Asks the AI to round every edge of the part (outside corners and inside blends) with auto_round, '
      + 'keeping holes, the bed face and mating faces exact. The two radii land in Parameters. With a face '
      + 'selected, that face stays sharp too.',
    example: 'round the outside edges 2 mm, leave the bottom sharp',
    needs: (_sel, m) => first(...aiFree(m)),
    run: (ctx) => ctx.ask(ROUND_INSTRUCTION),
  },
  {
    id: 'lighten', name: 'Lighten', group: 'Modify', icon: 'lighten',
    help: 'AI: cut 30–40% of the mass with windows or spokes, then round',
    longHelp: 'Asks the AI to cut windows between ribs in flat plates, or rebuild an open bracket as tapered '
      + 'spokes, aiming to remove 30–40% of the mass. Holes and mounting faces stay exact; edges are rounded last. '
      + 'Select a face first to lighten just that face.',
    example: 'lighten this plate by 50% with triangular windows',
    needs: (_sel, m) => first(...aiFree(m)),
    run: (ctx) => ctx.ask(LIGHTEN_INSTRUCTION),
  },
  {
    id: 'protect', name: 'Keep sharp', group: 'Modify', icon: 'protect',
    help: 'AI: keep the selected faces flat and their edges sharp when rounding',
    longHelp: 'On a rounded part (auto_round), asks the AI to add the selected faces to auto_round\'s keep list, '
      + 'so they stay flat with sharp edges — a mating face or the bed face. This is the footer\'s Protect.',
    example: 'keep the bottom face sharp',
    needs: (sel, m) => first(...aiFree(m), [!m.autoRound, 'Round the part first'],
                             [sel.faces.length === 0, 'Select the faces to keep sharp']),
    run: (ctx) => ctx.ask(PROTECT_INSTRUCTION),
  },
  {
    id: 'fix', name: 'Fix with AI', group: 'Modify', icon: 'fix',
    help: 'Send the build error to the AI; it repairs the script and rebuilds',
    longHelp: 'When a build fails, sends the script and the error to the AI, which repairs the failing line, '
      + 'keeping the design intent, and builds again. Or edit the script or a parameter yourself and Build.',
    example: 'the fillet fails — make it fit',
    needs: (_sel, m) => first([m.status !== 'error', 'Only when a build fails'],
                              [m.asking, 'The AI is working on a change']),
    run: (ctx) => ctx.ask(FIX_INSTRUCTION),
  },
  // Inspect
  {
    id: 'measure', name: 'Measure', group: 'Inspect', icon: 'measure',
    help: 'The selected face\'s or edge\'s size, or the distance between two',
    longHelp: 'Select a face for its size (a hole: its diameter), or two faces for the distance between their '
      + 'centres, with X, Y and Z. An edge: its length, or a circle\'s diameter; two edges: the distance or the '
      + 'angle between them. The reading shows at the top left of the 3D view while they are selected; this '
      + 'copies it.',
    example: 'how far apart are these two holes?',
    needs: (sel, m) => first([sel.faces.length + sel.edges.length === 0, 'Select faces or edges'],
                             [sel.faces.length > 2, 'Select one or two faces'],
                             [!m.measure, 'Nothing to measure here']),
    detail: (_sel, m) => m.measure,
    run: (ctx) => ctx.copyMeasure(),
  },
  {
    id: 'section', name: 'Section', group: 'Inspect', icon: 'section', shortcut: 'Z',
    help: 'Cut the part open with a plane to see inside',
    longHelp: 'Cuts the 3D view open at a plane, to check wall thicknesses, insert depths and how a board fits; '
      + 'the script is not changed. With a flat face selected the plane starts just inside it, otherwise through '
      + 'the middle, square to the view. Drag its arrow or use the panel to move, turn or flip it; hover the cut '
      + 'for the wall thickness, or click two points on its outline for the distance.',
    example: 'how thick is the wall around the USB cutout?',
    label: (m) => (m.section ? 'Section off' : 'Section'),
    needs: (_sel, m) => first([m.sketching, 'Finish the sketch first']),
    run: (ctx) => ctx.section(),
  },
  // View
  {
    id: 'normal', name: 'Look at face', group: 'View', icon: 'normal', shortcut: 'N',
    help: 'Look straight at the selected face, or at the section',
    longHelp: 'Turns the view to look straight at the selected face (the last one clicked), for checking a '
      + 'sketch or a hole pattern square on; with the section on, straight at the cut. The Normal button below '
      + 'the 3D view does the same.',
    example: 'what is on this face?',
    label: (m) => (m.section ? 'Look at the cut' : 'Look at face'),
    needs: (sel, m) => first([sel.faces.length === 0 && !m.section, 'Select a face']),
    run: (ctx) => ctx.lookAtSelection(),
  },
  ...VIEW_OPS.map(([view, name, key]): Operation => ({
    id: `view-${view}`, name: view === 'iso' ? 'Iso view' : `${name} view`, group: 'View', icon: `view-${view}`,
    shortcut: key,
    help: view === 'iso' ? 'Look from the front, right and above' : `Look at the part from the ${view}`,
    longHelp: `Turns the view to the standard ${view === 'iso' ? 'isometric view (front, right and above)' : `${view} view`}`
      + '. The buttons along the bottom of the 3D view and the keys 1–6 and 0 do the same.',
    example: `show me the ${view} of the part`,
    needs: () => OK,
    run: (ctx) => ctx.setView(view),
  })),
  {
    id: 'ortho', name: 'Orthographic', group: 'View', icon: 'ortho', shortcut: 'O',
    help: 'Switch between perspective and orthographic',
    longHelp: 'Orthographic has no perspective: parallel edges stay parallel, for checking alignment. Press '
      + 'again for perspective.',
    example: 'are these two faces level?',
    label: (m) => (m.ortho ? 'Perspective' : 'Orthographic'),
    needs: () => OK,
    run: (ctx) => ctx.toggleOrtho(),
  },
  {
    id: 'params', name: 'Parameters', group: 'View', icon: 'params', shortcut: 'P',
    help: 'Show or hide the parameters',
    longHelp: 'Shows or hides the named sizes of the part. Edit a value and the part rebuilds; hover one to '
      + 'see which faces it moves.',
    example: 'make the walls a parameter',
    label: (m) => (m.showParams ? 'Hide parameters' : 'Show parameters'),
    needs: (_sel, m) => first([!m.hasParams, 'This part has no parameters']),
    run: (ctx) => ctx.toggleParams(),
  },
  // File
  {
    id: 'build', name: 'Build', group: 'File', icon: 'build', pinned: true,
    help: 'Rebuild from the script',
    longHelp: 'Rebuilds the part from the script after editing it by hand (Ctrl/⌘+Enter in the script does the '
      + 'same). While a build runs, this cancels it.',
    example: 'rebuild it',
    label: (m) => (m.status === 'building' ? 'Cancel build' : 'Build'),
    needs: (_sel, m) => first([!m.hasCode, 'Nothing to build']),
    run: (ctx) => ctx.build(),
  },
  {
    id: 'import-step', name: 'Import STEP', group: 'File', icon: 'import',
    help: 'Start this part from a STEP file (.step/.stp)',
    longHelp: 'Replaces the script with one that imports a STEP file, so a part from another CAD tool can be '
      + 'changed here. The script it replaces stays in Versions.',
    example: 'add mounting holes to the imported part',
    needs: (_sel, m) => first([m.importing, 'Importing…'], [m.status === 'building', 'Wait for the build'],
                              [m.sketching, 'Finish the sketch first']),
    run: (ctx) => ctx.importStep(),
  },
  ...EXPORTS.map(([format, name, icon, help, longHelp]): Operation => ({
    id: `export-${format}`, name, group: 'File', icon, help, longHelp,
    example: format === 'stl' ? 'make it print without supports' : 'is this ready to make?',
    needs: (_sel, m) => first([m.exporting, 'Exporting…'], ...built(m)),
    run: (ctx) => ctx.exportAs(format),
  })),
  {
    id: 'versions', name: 'Versions', group: 'File', icon: 'versions',
    help: 'Browse and restore saved versions',
    longHelp: 'Every build that changed the script is kept as a version. Browse them and restore any one; '
      + 'restoring is itself a new version, so nothing is lost.',
    example: 'undo the last change',
    needs: (_sel, m) => first([m.sketching, 'Finish the sketch first']),
    run: (ctx) => ctx.versions(),
  },
  {
    id: 'process', name: 'Process', group: 'File', icon: 'process',
    help: 'How the part will be made — the AI designs every change to it',
    longHelp: 'Standing notes on how the part is made (FDM printing by default): clearances, fits, wall '
      + 'thickness. The AI designs every edit to them.',
    example: 'this will be CNC milled from aluminium',
    needs: (_sel, m) => first([m.sketching, 'Finish the sketch first']),
    run: (ctx) => ctx.process(),
  },
  {
    id: 'context-add', name: 'Add context file', group: 'File', icon: 'context',
    help: 'Add a datasheet PDF or a photo for the AI to design from',
    longHelp: 'Adds a reference file (a PDF such as a board\'s datasheet, or a photo) to this part or to the whole '
      + 'project. The AI reads the files that are in context with each message and cites the page each dimension '
      + 'came from. Opens the Context layout, where you choose pages and switch files on or off.',
    example: 'make a case for the board in the datasheet',
    needs: (_sel, m) => first([m.sketching, 'Finish the sketch first']),
    run: (ctx) => ctx.addContextFile(),
  },
];

export const opById = (id: string): Operation | undefined => OPERATIONS.find((o) => o.id === id);

/** The operation a single key runs (letters either case), if any. */
export function opForKey(key: string): Operation | undefined {
  if (key.length !== 1) return undefined;
  const k = key.toUpperCase();
  return OPERATIONS.find((o) => o.shortcut === k);
}

// ---- layouts ----

/** What sits beside the 3D view, in the order L (or Ctrl/⌘+\) steps through them. */
export type Layout = 'code' | 'chat' | 'context' | 'model' | 'ops';
export const LAYOUTS: [Layout, string, string][] = [
  ['code', 'Code', 'Script on the left, chat along the bottom'],
  ['chat', 'Chat', 'Chat on the left in place of the script'],
  ['context', 'Context', 'The reference files (PDFs, photos) the AI reads, for this part and the project'],
  ['model', '3D', 'The 3D view alone, as large as the window allows'],
  ['ops', 'Operations', 'Every operation as a grid, enabled by what is selected'],
];

/** The key that goes straight to Operations, and back to the layout before. */
export const OPS_KEY = 'U';

export const isLayout = (l: unknown): l is Layout => LAYOUTS.some(([k]) => k === l);

/** The next layout (dir 1: L, Ctrl/⌘+\) or the one before (dir -1: Shift+L). */
export function stepLayout(cur: Layout, dir: 1 | -1): Layout {
  const i = LAYOUTS.findIndex(([k]) => k === cur);
  return LAYOUTS[(i + dir + LAYOUTS.length) % LAYOUTS.length]![0];
}

/** U: to Operations, or from it back to `prev` (the layout before it). */
export function toggleOps(cur: Layout, prev: Layout): Layout {
  if (cur !== 'ops') return 'ops';
  return prev === 'ops' ? 'code' : prev;
}

// ---- keys ----

/** The part editor's other keys (not operations), for the help and the
 *  conflict check: no operation shortcut may use one. */
export const RESERVED_KEYS: Record<string, string> = {
  L: 'next layout (Shift+L: the one before)',
  [OPS_KEY]: 'Operations layout, and back',
  [FILTER_KEY]: 'what a click picks: faces + edges, faces, edges',
  '?': 'help',
  T: 'Top plane, in the Sketch… menu',
  F: 'Front plane, in the Sketch… menu',
  R: 'Right plane, in the Sketch… menu',
  Tab: 'next drag handle',
  Alt: 'hold for dimensions',
  Escape: 'close a menu or dialog; leave Operations',
  'Ctrl+\\': 'next layout, even while typing',
  'Ctrl+Enter': 'build, in the script',
};

/** The keys the face sketcher uses (it owns the keyboard while open, so the
 *  part editor's keys are off then — but the Operations key avoids them too,
 *  so one key never means two things). */
export const SKETCH_KEYS = [
  '.', 'L', 'C', 'R', 'E', 'P', 'D', 'S', '?', 'A', 'G', 'M', 'K', '=', 'J', 'H', 'V', 'N', 'T', 'B', 'I', 'Y',
  'W', 'F', 'X', 'Q', 'Home', 'Escape', 'Delete', 'Backspace',
];

// ---- recent ----

export const RECENT_KEY = 'intentcad-recent-ops';
export const RECENT_MAX = 4;

/** The recent list with `id` first (no repeats, at most RECENT_MAX); the
 *  views aren't operations worth remembering. */
export function pushRecent(list: string[], id: string): string[] {
  const op = opById(id);
  if (!op || op.group === 'View') return list;
  return [id, ...list.filter((x) => x !== id)].slice(0, RECENT_MAX);
}

export function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!opById(x)).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export function saveRecent(list: string[]): void {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* private window: not remembered */ }
}
