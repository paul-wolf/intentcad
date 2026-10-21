/**
 * Minimal dependency-free WebGL viewer for a static triangle-soup mesh
 * (flat positions + per-face normals, as returned by /api/build/).
 *
 * Deliberately not three.js — this only needs to draw one static solid with
 * orbit + zoom, perspective or orthographic. Column-major 4x4 math, two light directions for winding-
 * independent shading, render-on-demand.
 */

import { add, cross, dot, scale, sub, faceMotion, dragAmount, dragShift, snapToStep, snapToPlane, type Vec3 } from './dragHandle';
import { bedLevel, CEILING_DEG, onBed, overhangAngle, overhangHoverText, overhangKind, type OverhangKind } from './overhang';
import {
  lookFrom, axisView, orbit, slerp, quatToMat4, easeInOutCubic, VIEW_DIRS,
  type Quat, type StandardView,
} from './viewOrient';
import { planeQuat, type PlaneBasis } from './sketchPlane';
import { bodyColor, rangesWithout } from './bodyColors';
import { labelCorner, outlineSegments, planeCorners, type PlaneShape } from './constructionPlanes';
import { choosePick, edgesNear, segmentDistance, selectable, EDGE_PX, type EdgeCandidate, type EdgeLike, type PickFilter, type ScreenEdge } from './edgePick';
import {
  buildOutline, cutDepth, cutNormal, faceBodies, fromPlane, insideOutline, nearestSegment, planeBasis, planePoint,
  shaderPlane, signedVolume6, toPlane, vertexDots, wallThickness, type Outline, type Section,
} from './section';

export interface ViewerMesh {
  positions: number[];
  normals: number[];
}

type Mat4 = Float32Array;

function identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

function perspective(fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) * nf;
  m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}

/** Orthographic projection of a view-space box (half extents, near/far). */
function ortho(halfW: number, halfH: number, near: number, far: number): Mat4 {
  const m = new Float32Array(16);
  m[0] = 1 / halfW;
  m[5] = 1 / halfH;
  m[10] = -2 / (far - near);
  m[14] = -(far + near) / (far - near);
  m[15] = 1;
  return m;
}

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[r + k * 4]! * b[k + c * 4]!;
      out[r + c * 4] = s;
    }
  }
  return out;
}

function translation(x: number, y: number, z: number): Mat4 {
  const m = identity();
  m[12] = x; m[13] = y; m[14] = z;
  return m;
}

/** Upper-left 3x3 of a rotation-only 4x4 (valid normal matrix for pure rotation). */
function mat3Of(m: Mat4): Float32Array {
  return new Float32Array([m[0]!, m[1]!, m[2]!, m[4]!, m[5]!, m[6]!, m[8]!, m[9]!, m[10]!]);
}

/** Inverse of a 4x4 (column-major); null if singular. */
function invert(m: Mat4): Mat4 | null {
  const a = Array.from(m);
  const inv = new Float32Array(16);
  const [a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13, a14, a15] = a as number[] as
    [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];
  const b0 = a0 * a5 - a1 * a4, b1 = a0 * a6 - a2 * a4, b2 = a0 * a7 - a3 * a4;
  const b3 = a1 * a6 - a2 * a5, b4 = a1 * a7 - a3 * a5, b5 = a2 * a7 - a3 * a6;
  const b6 = a8 * a13 - a9 * a12, b7 = a8 * a14 - a10 * a12, b8 = a8 * a15 - a11 * a12;
  const b9 = a9 * a14 - a10 * a13, b10 = a9 * a15 - a11 * a13, b11 = a10 * a15 - a11 * a14;
  const det = b0 * b11 - b1 * b10 + b2 * b9 + b3 * b8 - b4 * b7 + b5 * b6;
  if (!det) return null;
  const k = 1 / det;
  inv[0] = (a5 * b11 - a6 * b10 + a7 * b9) * k;
  inv[1] = (a2 * b10 - a1 * b11 - a3 * b9) * k;
  inv[2] = (a13 * b5 - a14 * b4 + a15 * b3) * k;
  inv[3] = (a10 * b4 - a9 * b5 - a11 * b3) * k;
  inv[4] = (a6 * b8 - a4 * b11 - a7 * b7) * k;
  inv[5] = (a0 * b11 - a2 * b8 + a3 * b7) * k;
  inv[6] = (a14 * b2 - a12 * b5 - a15 * b1) * k;
  inv[7] = (a8 * b5 - a10 * b2 + a11 * b1) * k;
  inv[8] = (a4 * b10 - a5 * b8 + a7 * b6) * k;
  inv[9] = (a1 * b8 - a0 * b10 - a3 * b6) * k;
  inv[10] = (a12 * b4 - a13 * b2 + a15 * b0) * k;
  inv[11] = (a9 * b2 - a8 * b4 - a11 * b0) * k;
  inv[12] = (a5 * b7 - a4 * b9 - a6 * b6) * k;
  inv[13] = (a0 * b9 - a1 * b7 + a2 * b6) * k;
  inv[14] = (a13 * b1 - a12 * b3 - a14 * b0) * k;
  inv[15] = (a8 * b3 - a9 * b1 + a10 * b0) * k;
  return inv;
}

const VERT = `
attribute vec3 aPos;
attribute vec3 aNormal;
uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uModel;
uniform mat3 uNormal;
varying vec3 vNormal;
varying vec3 vWorld;
varying vec3 vWorldN;
void main() {
  vNormal = uNormal * aNormal;
  vWorld = aPos;
  vWorldN = aNormal;
  gl_Position = uProj * uView * uModel * vec4(aPos, 1.0);
}`;

// uClip: discard what lies beyond the plane dot(p, xyz) = w (sketch mode
// cuts away the part between the camera and the sketch plane). uSec is the
// section view's plane the same way, on while uSecOn is 1; a face lying in it
// whose material was cut away goes too. uDim fades the colour toward a
// desaturated mix with the background uBg.
const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec3 vNormal;
varying vec3 vWorld;
varying vec3 vWorldN;
uniform vec3 uColor;
uniform float uAlpha;
uniform vec4 uClip;
uniform vec4 uSec;
uniform float uSecOn;
uniform float uDim;
uniform vec3 uBg;
// overhangs (overhang.ts): uDown into the bed, uOv = (sin threshold, sin ceiling,
// asin threshold, bed level along uDown); uFlip -1 on a body wound inside out
uniform float uOvOn;
uniform vec3 uDown;
uniform vec4 uOv;
uniform float uFlip;
void main() {
  if (dot(vWorld, uClip.xyz) > uClip.w) discard;
  if (uSecOn > 0.5) {
    float s = dot(vWorld, uSec.xyz) - uSec.w;
    if (s > 1e-4 || (s > -1e-3 && dot(vWorldN, uSec.xyz) < -0.99)) discard;
  }
  vec3 n = normalize(vNormal);
  vec3 l1 = normalize(vec3(0.4, 0.7, 0.8));
  vec3 l2 = normalize(vec3(-0.5, -0.3, -0.6));
  float d1 = max(dot(n, l1), 0.0);
  float d2 = max(dot(n, l2), 0.0);
  float light = 0.28 + 0.62 * d1 + 0.22 * d2;
  vec3 col = uColor * light;
  if (uOvOn > 0.5) {
    float s = dot(normalize(vWorldN) * uFlip, uDown);
    if (s > 0.9995 && dot(vWorld, uDown) > uOv.w - 0.01) {
      // on the bed: faint diagonal stripes
      float k = step(fract((gl_FragCoord.x + gl_FragCoord.y) / 12.0), 0.35);
      col = mix(col, vec3(0.25, 0.55, 0.95) * light, 0.18 + 0.22 * k);
    } else if (s > uOv.x) {
      // past the threshold: stronger the flatter it is
      float a = asin(clamp(s, 0.0, 1.0));
      float k = clamp((a - uOv.z) / (1.5707963 - uOv.z), 0.0, 1.0);
      vec3 tint = s >= uOv.y ? vec3(0.85, 0.1, 0.12) : vec3(0.88, 0.28, 0.72);
      col = mix(col, tint * (0.45 + 0.55 * light), 0.35 + 0.5 * k);
    }
  }
  float g = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, mix(vec3(g), uBg, 0.62), uDim);
  gl_FragColor = vec4(col, uAlpha);
}`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('shader compile: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

const LINE_VERT = `
attribute vec3 aPos;
uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uModel;
varying vec3 vWorld;
void main() {
  vWorld = aPos;
  gl_Position = uProj * uView * uModel * vec4(aPos, 1.0);
}`;

// lines are cut by the section too (uSec, as in FRAG)
const LINE_FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec3 vWorld;
uniform vec3 uColor;
uniform vec4 uSec;
uniform float uSecOn;
void main() {
  if (uSecOn > 0.5 && dot(vWorld, uSec.xyz) > uSec.w + 1e-4) discard;
  gl_FragColor = vec4(uColor, 1.0);
}`;

// the section's cap: flat, with a fine diagonal hatch in screen space
// (uHatch: its spacing, uLine: a line's width, both in device px)
const CAP_VERT = `
attribute vec3 aPos;
uniform mat4 uPV;
void main() { gl_Position = uPV * vec4(aPos, 1.0); }`;
const CAP_FRAG = `
precision mediump float;
uniform vec3 uColor;
uniform float uHatch;
uniform float uLine;
void main() {
  float d = abs(mod(gl_FragCoord.x + gl_FragCoord.y, uHatch) - 0.5 * uHatch);
  float k = 1.0 - smoothstep(0.5 * uLine, 0.5 * uLine + 1.0, d);
  gl_FragColor = vec4(uColor * (1.0 - 0.18 * k), 1.0);
}`;

// a construction plane's fill: flat, translucent
const FILL_FRAG = `
precision mediump float;
uniform vec3 uColor;
uniform float uAlpha;
void main() { gl_FragColor = vec4(uColor, uAlpha); }`;

// Screen-space thick lines (GL line width is 1 px on most platforms): each
// segment is a quad, its corners pushed sideways by half the width in pixels.
// uBias pulls the line toward the camera so it sits on its face, not in it.
const THICK_VERT = `
attribute vec3 aPos;
attribute vec3 aOther;
attribute float aSide;
uniform mat4 uPV;
uniform vec2 uHalfPx;
uniform float uWidth;
uniform float uBias;
varying vec3 vWorld;
void main() {
  vWorld = aPos;
  vec4 a = uPV * vec4(aPos, 1.0);
  vec4 b = uPV * vec4(aOther, 1.0);
  vec2 d = b.xy / b.w * uHalfPx - a.xy / a.w * uHalfPx;
  vec2 n = length(d) > 0.0 ? normalize(vec2(-d.y, d.x)) : vec2(0.0, 1.0);
  a.xy += n * aSide * (uWidth * 0.5) / uHalfPx * a.w;
  a.z -= uBias * a.w;
  gl_Position = a;
}`;

/** A sketch drawn on a face, as 3D segments [x,y,z, x,y,z, …] (pairs). */
export interface SketchLines { id: string; name: string; segments: number[] }

/** Thick-line vertex data for segment pairs: 6 vertices × (pos, other, side). */
function thickVerts(segs: ArrayLike<number>): Float32Array {
  const n = Math.floor(segs.length / 6);
  const out = new Float32Array(n * 6 * 7);
  let o = 0;
  const put = (p: number, q: number, side: number) => {
    out[o++] = segs[p]!; out[o++] = segs[p + 1]!; out[o++] = segs[p + 2]!;
    out[o++] = segs[q]!; out[o++] = segs[q + 1]!; out[o++] = segs[q + 2]!;
    out[o++] = side;
  };
  for (let i = 0; i < n; i++) {
    const p = i * 6, q = p + 3;
    // at q the direction is reversed, so its sides swap sign
    put(p, q, 1); put(p, q, -1); put(q, p, -1);
    put(p, q, -1); put(q, p, 1); put(q, p, -1);
  }
  return out;
}

/** Lines a dialog draws over the part (a pattern's instances): segment
 *  pairs in one colour, `width` CSS px; drawn dimmer where the part hides them. */
export interface MarkLines { segments: number[]; color: Vec3; width?: number }

/** A face's triangle range in the mesh + its plane (for pick / highlight). */
export interface FaceRange {
  index: number; start: number; count: number;
  kind: string; area: number; center: [number, number, number]; normal: [number, number, number];
  radius?: number | null;
  size?: [number, number, number];
}

/** A dimension pinned to world geometry: a label at `point`, optionally a
 * double-arrow along `dir` (both unit-length; see backend sensitivity). */
export interface DimAnchor {
  key: string;
  label: string;
  point: [number, number, number];
  dir?: [number, number, number] | null;
}

/** A dimension projected into the current view, for the HTML overlay. */
export interface PlacedDim {
  key: string; label: string;
  x: number; y: number;      // screen px of the anchor
  ax: number; ay: number;    // screen px of the arrow tip (point + dir)
  visible: boolean;
}

/** A drag handle on one face: dragging moves the face along `shift` (its world
 * motion per unit of the param — see backend sensitivity `shifts`). Or, with
 * `at`, a handle at a point (a fillet's edge), drawn its value out from it
 * along `shift`: the drag moves no face, it reports the value as it goes
 * (onHandleMove) — the dialog's ghost shows it. */
export interface DragHandle {
  face: number;
  shift: Vec3;
  dr: number;         // radius change per unit, for a cylinder face (else 0)
  value: number;      // the param's current value
  moves: number[];    // faces the param changes — not snap targets
  /** the handle's anchor, instead of the face's centre */
  at?: Vec3;
  /** the grid the drag snaps to (default 0.5, Shift 0.1) */
  step?: number;
  /** the smallest value the drag goes to */
  min?: number;
  /** a point handle: snap its value onto the planes of parallel flat faces
   *  (a construction plane's offset along `shift`) */
  snapFaces?: boolean;
  /** a rotation handle about an axis through `at`: the value is an angle in
   *  degrees, the handle sits at at + arm·(w cos a + n sin a) (w, n unit and
   *  square to the axis); it snaps to `step`° (default 1; Shift `fine`,
   *  default 0.1), and within 2° of a multiple of `stick` onto it. `arm`:
   *  the knob at least this far out (clear of a cylinder it turns round). */
  turn?: { w: Vec3; n: Vec3; step?: number; fine?: number; stick?: number; arm?: number };
}

/** The handle projected into the current view, for the HTML overlay. */
export interface PlacedHandle {
  x: number; y: number;      // screen px of the face anchor (follows a drag)
  ax: number; ay: number;    // screen px of the arrow tip
  visible: boolean;
  dragging: boolean;
  value: number;             // the param value at the current drag position
  snapFace: number | null;   // the face whose plane the drag snapped to
}

export interface Viewer {
  update(mesh: ViewerMesh, faces?: FaceRange[]): void;
  /** Highlight edges: flat GL_LINES vertices [x,y,z, x,y,z, ...] (pairs). */
  highlightEdges(segments: number[]): void;
  /** Highlight faces by inventory index. */
  selectFaces(indices: number[]): void;
  /** The part's edges (the build result's), for picking and drawing. Call
   *  after update(); clears the edge selection. */
  setEdges(edges: EdgeLike[]): void;
  /** Draw these edges as selected: thick, in the selection colour, dimmer
   *  where the part hides them. */
  selectEdges(indices: number[]): void;
  /** Light one edge brightly, through anything in front (a dialog row being
   *  hovered); null for none. */
  hoverEdge(index: number | null): void;
  /** The construction planes to draw: translucent rectangles the size of the
   *  part (a little larger), outlined, their names placed via onPlaneLabels.
   *  A click on an outline picks the plane ({plane: name}). */
  setPlanes(planes: PlaneShape[]): void;
  /** Draw these planes as selected. */
  selectPlanes(names: string[]): void;
  /** Light one plane (its label or a list row is hovered); null for none. */
  hoverPlane(name: string | null): void;
  /** What a click picks: faces + edges (an edge near the cursor wins), faces, edges. */
  setPickFilter(f: PickFilter): void;
  /** Set the dimension overlay (empty to clear). Reported back via onDims. */
  setDims(dims: DimAnchor[]): void;
  /** A dialog's marks: lines drawn over the part, and points placed on
   *  screen each frame via onMarks (a pattern's instance numbers). null clears. */
  setMarks(m: { lines: MarkLines[]; points: DimAnchor[] } | null): void;
  /** Show a drag handle on a face (null to remove). Cancels any drag. */
  setHandle(h: DragHandle | null): void;
  /** Drop the preview left by a released drag (normally the rebuild that the
   *  drop triggers replaces it — this is for when there isn't one). */
  clearDragPreview(): void;
  /** Capture the current view as a transparent PNG data URL of just the solid
   *  (no grid/overlays) — for a part thumbnail. Returns '' if nothing built. */
  capture(w?: number, h?: number): string;
  /** Animate to a standard view (front, back, …, iso). */
  setView(view: StandardView): void;
  /** Animate to look straight at a face with this outward normal. */
  lookAlong(normal: Vec3): void;
  /** Animate to look from the + side of a world axis, or the − side if
   *  already there (the gizmo's axis labels). */
  viewAxis(axis: 'X' | 'Y' | 'Z'): void;
  /** Switch perspective ↔ orthographic; returns true if now orthographic. */
  toggleOrtho(): boolean;
  /**
   * Sketch mode on a face plane: remembers the current view, then animates
   * (orthographic) to look straight at the plane with the given camera. Call
   * right after the canvas has moved/resized for sketch mode: the first frame
   * is compensated so the part doesn't jump. Orbit, zoom and picking are off;
   * the part dims, the face stays lit, and geometry in front of the plane is
   * cut away (unless `clip` is false: a base plane, where the part is kept
   * whole). Rendered synchronously.
   */
  enterSketch(s: { plane: PlaneBasis; face: number; bg: [number, number, number];
                   center: Vec3; halfH: number; clip?: boolean }): void;
  /** Sketch mode: the sketch viewport moved — follow it (synchronous render). */
  setSketchCamera(center: Vec3, halfH: number): void;
  /** Leave sketch mode: animate back to the view before enterSketch. Call
   *  right after the canvas has moved back. */
  exitSketch(): void;
  /** The sketches drawn on faces, shown as lines on the part (hidden while
   *  sketching). Hover reports the name via onSketchHover; double-click
   *  calls onSketchOpen. */
  setSketchLines(sketches: SketchLines[]): void;
  /** Sketch mode: preview an extrude as world-space segment pairs (the shapes
   *  at each end + side edges, and arrows the way it goes). The first call
   *  tilts the view off the plane, framed on the part and the preview; null
   *  turns back to the sketch. */
  setExtrudePreview(p: { edges: number[]; arrows: number[]; color: Vec3 } | null): void;
  /** Show what an operation would make (Shell, Hole: a candidate build) in
   *  place of the part, tinted `color`; the selected faces of the part show
   *  through it. `extra`: a second mesh drawn over it in its own colour
   *  (Mirror body: the mirror image). null shows the part again. */
  setPreviewMesh(p: { mesh: ViewerMesh; color: Vec3; extra?: { mesh: ViewerMesh; color: Vec3 } | null } | null): void;
  /** Light one face of the part brightly, through anything in front (a
   *  dialog row being hovered); null for none. */
  hoverFace(index: number | null): void;
  /** A dialog covers `px` CSS px along the left of the view: draw the part
   *  centred in the rest (0 for the whole view). */
  setInset(px: number): void;
  /** The section view: cut the part open at this plane (null: whole). Kept
   *  across update(); off while sketching and in a thumbnail. Clears the
   *  measured points. */
  setSection(s: Section | null): void;
  /** The overhang highlight: shade the faces past `threshold`° from vertical
   *  as seen with `down` into the bed (overhang.ts); null turns it off. Kept
   *  across update(); off while sketching and in a thumbnail. Hover reports
   *  the angle via onOverhangHover. */
  setOverhangs(o: { down: Vec3; threshold: number } | null): void;
  /** The vertex ranges of bodies wound inside out (their normals point in). */
  invertedRanges(): [number, number][];
  /** For starting a section: the direction toward the camera (from the part)
   *  and the part's centre. */
  sectionFrame(): { back: Vec3; center: Vec3 };
  /** Drop the points clicked on the section outline. */
  clearSectionPoints(): void;
  /** Cancel a drag in progress (a handle or the section plane), as Esc does;
   *  false if there was none. */
  cancelDrag(): boolean;
  dispose(): void;
}

/** What the section view measures, each frame while it is on: the wall under
 *  the pointer, and the distance between two points clicked on the outline.
 *  x, y: CSS px of the measure line's middle; `approx` when a curved face
 *  (measured on its tessellation) is involved. */
export interface SectionMeasure {
  wall: { mm: number; approx: boolean; x: number; y: number } | null;
  points: number;
  distance: { mm: number; approx: boolean; x: number; y: number } | null;
}

/** A world axis as seen in the current view: unit direction (x right, y up,
 * z toward the viewer) — for drawing an orientation gizmo. */
export interface AxisDir { name: string; x: number; y: number; z: number; color: string }

/** What a click picked: a face, an edge (build-result index), a
 *  construction plane (by name, on its outline), or nothing. */
/** A face pick carries the point clicked on it (world). */
export type ViewerPick = { face: FaceRange; point?: Vec3 } | { edge: number } | { plane: string } | null;

/** A construction plane's name, projected for the HTML overlay (CSS px). */
export interface PlacedPlaneLabel { name: string; x: number; y: number; visible: boolean; preview: boolean }

export interface ViewerOpts {
  color?: [number, number, number];
  /** A click picked a face or an edge (null: empty space); `shift` adds to a
   *  selection. Which can be picked follows setPickFilter. */
  onPick?: (hit: ViewerPick, mods: { shift: boolean; alt: boolean }) => void;
  /** An edge was double-clicked (not a drawn sketch): `face` is the face it
   *  borders that the cursor was over (or the one facing the camera). */
  onEdgeDoubleClick?: (hit: { edge: number; face: number | null }, mods: { shift: boolean; alt: boolean }) => void;
  /** Called each frame with the view-space directions of the X/Y/Z axes. */
  onAxes?: (dirs: AxisDir[]) => void;
  /** Called each frame with the projected dimension overlay (see setDims). */
  onDims?: (dims: PlacedDim[]) => void;
  /** Called each frame with the projected drag handle (see setHandle). */
  onHandle?: (h: PlacedHandle | null) => void;
  /** A handle drag was released at a new param value. The preview stays up
   *  until the next update() / setHandle() / clearDragPreview(). */
  onHandleDrop?: (value: number) => void;
  /** The value of a point handle's drag (DragHandle.at) as it moves; its
   *  start value again, `done`, if the drag is cancelled (a drop: onHandleDrop). */
  onHandleMove?: (value: number, done: boolean) => void;
  /** The pointer is over a drawn sketch (null: left it); CSS px in the canvas. */
  onSketchHover?: (hit: { id: string; name: string; x: number; y: number } | null) => void;
  /** A drawn sketch was double-clicked. */
  onSketchOpen?: (id: string) => void;
  /** The section plane was dragged (`dragging` until released; a cancelled
   *  drag reports the start again, not dragging). `snapFace`: the parallel
   *  face it snapped onto. */
  onSection?: (s: Section, st: { dragging: boolean; snapFace: number | null }) => void;
  /** Called each frame with the section plane's arrow handle (null: off). */
  onSectionHandle?: (h: PlacedHandle | null) => void;
  /** Called each frame with the section's measurements (null: off). */
  onSectionMeasure?: (m: SectionMeasure | null) => void;
  /** Called each frame with where the construction planes' names go. */
  onPlaneLabels?: (labels: PlacedPlaneLabel[]) => void;
  /** Called each frame with the marks' points, projected (see setMarks). */
  onMarks?: (points: PlacedDim[]) => void;
  /** The pointer is over a highlighted overhang (setOverhangs): its angle in
   *  words ("62° overhang"), at CSS px in the canvas; null when it left. */
  onOverhangHover?: (h: { text: string; kind: OverhangKind; x: number; y: number } | null) => void;
}

export function createViewer(canvas: HTMLCanvasElement, opts: ViewerOpts = {}): Viewer {
  const color = opts.color ?? [0.62, 0.66, 0.72];
  const gl = canvas.getContext('webgl', { antialias: true, depth: true, stencil: true, preserveDrawingBuffer: true });
  if (!gl) throw new Error('WebGL not available');

  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error('link: ' + gl.getProgramInfoLog(prog));
  }
  gl.useProgram(prog);

  const aPos = gl.getAttribLocation(prog, 'aPos');
  const aNormal = gl.getAttribLocation(prog, 'aNormal');
  const uProj = gl.getUniformLocation(prog, 'uProj');
  const uView = gl.getUniformLocation(prog, 'uView');
  const uModel = gl.getUniformLocation(prog, 'uModel');
  const uNormal = gl.getUniformLocation(prog, 'uNormal');
  const uColor = gl.getUniformLocation(prog, 'uColor');
  const uAlpha = gl.getUniformLocation(prog, 'uAlpha');
  const uClip = gl.getUniformLocation(prog, 'uClip');
  const uDim = gl.getUniformLocation(prog, 'uDim');
  const uBg = gl.getUniformLocation(prog, 'uBg');
  const uSec = gl.getUniformLocation(prog, 'uSec');
  const uSecOn = gl.getUniformLocation(prog, 'uSecOn');
  const uOvOn = gl.getUniformLocation(prog, 'uOvOn');
  const uDown = gl.getUniformLocation(prog, 'uDown');
  const uOv = gl.getUniformLocation(prog, 'uOv');
  const uFlip = gl.getUniformLocation(prog, 'uFlip');

  const posBuf = gl.createBuffer()!;
  const normBuf = gl.createBuffer()!;
  const previewBuf = gl.createBuffer()!;   // the dragged face's offset triangles
  // an operation's candidate result (setPreviewMesh), drawn in place of the part
  const candPosBuf = gl.createBuffer()!;
  const candNormBuf = gl.createBuffer()!;
  let cand: { count: number; color: Vec3; inverted: boolean } | null = null;
  let candPositions: number[] = [];
  // drawn over the candidate in its own colour (setPreviewMesh's extra)
  const extraPosBuf = gl.createBuffer()!;
  const extraNormBuf = gl.createBuffer()!;
  let candExtra: { count: number; color: Vec3 } | null = null;
  let hovered: number | null = null;
  const HOVER: [number, number, number] = [1.0, 0.85, 0.3];

  // second program: bright lines for highlighting edges (drawn over the mesh)
  const lineProg = gl.createProgram()!;
  gl.attachShader(lineProg, compile(gl, gl.VERTEX_SHADER, LINE_VERT));
  gl.attachShader(lineProg, compile(gl, gl.FRAGMENT_SHADER, LINE_FRAG));
  gl.linkProgram(lineProg);
  const lPos = gl.getAttribLocation(lineProg, 'aPos');
  const lProj = gl.getUniformLocation(lineProg, 'uProj');
  const lView = gl.getUniformLocation(lineProg, 'uView');
  const lModel = gl.getUniformLocation(lineProg, 'uModel');
  const lColor = gl.getUniformLocation(lineProg, 'uColor');
  const lSec = gl.getUniformLocation(lineProg, 'uSec');
  const lSecOn = gl.getUniformLocation(lineProg, 'uSecOn');
  const lineBuf = gl.createBuffer()!;
  let lineVertexCount = 0;
  const HIGHLIGHT: [number, number, number] = [1.0, 0.5, 0.05];

  // third program: thick lines for the sketches drawn on faces
  const thickProg = gl.createProgram()!;
  gl.attachShader(thickProg, compile(gl, gl.VERTEX_SHADER, THICK_VERT));
  gl.attachShader(thickProg, compile(gl, gl.FRAGMENT_SHADER, LINE_FRAG));
  gl.linkProgram(thickProg);
  const tPos = gl.getAttribLocation(thickProg, 'aPos');
  const tOther = gl.getAttribLocation(thickProg, 'aOther');
  const tSide = gl.getAttribLocation(thickProg, 'aSide');
  const tPV = gl.getUniformLocation(thickProg, 'uPV');
  const tHalfPx = gl.getUniformLocation(thickProg, 'uHalfPx');
  const tWidth = gl.getUniformLocation(thickProg, 'uWidth');
  const tBias = gl.getUniformLocation(thickProg, 'uBias');
  const tColor = gl.getUniformLocation(thickProg, 'uColor');
  const tSec = gl.getUniformLocation(thickProg, 'uSec');
  const tSecOn = gl.getUniformLocation(thickProg, 'uSecOn');

  // fourth program: the section's caps, drawn where the stencil says the
  // plane is inside the solid
  const capProg = gl.createProgram()!;
  gl.attachShader(capProg, compile(gl, gl.VERTEX_SHADER, CAP_VERT));
  gl.attachShader(capProg, compile(gl, gl.FRAGMENT_SHADER, CAP_FRAG));
  gl.linkProgram(capProg);
  const cPos = gl.getAttribLocation(capProg, 'aPos');
  const cPV = gl.getUniformLocation(capProg, 'uPV');
  const cColor = gl.getUniformLocation(capProg, 'uColor');
  const cHatch = gl.getUniformLocation(capProg, 'uHatch');
  const cLine = gl.getUniformLocation(capProg, 'uLine');
  // fifth: construction planes' translucent fills
  const fillProg = gl.createProgram()!;
  gl.attachShader(fillProg, compile(gl, gl.VERTEX_SHADER, CAP_VERT));
  gl.attachShader(fillProg, compile(gl, gl.FRAGMENT_SHADER, FILL_FRAG));
  gl.linkProgram(fillProg);
  const fPos = gl.getAttribLocation(fillProg, 'aPos');
  const fPV = gl.getUniformLocation(fillProg, 'uPV');
  const fColor = gl.getUniformLocation(fillProg, 'uColor');
  const fAlpha = gl.getUniformLocation(fillProg, 'uAlpha');
  const hasStencil = !!gl.getContextAttributes()?.stencil;
  const sketchBuf = gl.createBuffer()!;
  // a dialog's marks (setMarks): thick lines, and points reported via onMarks
  const markBuf = gl.createBuffer()!;
  let markRanges: { first: number; count: number; color: Vec3; width: number }[] = [];
  let markPoints: DimAnchor[] = [];
  let sketchLines: SketchLines[] = [];
  let sketchRanges: { id: string; first: number; count: number }[] = [];
  let hoverSketch: string | null = null;
  const SKETCH_LINE: [number, number, number] = [0.25, 0.62, 1.0];
  const SKETCH_HOVER: [number, number, number] = [0.55, 0.82, 1.0];
  // the part's edges: all of them in one thick-line buffer, a range each, so
  // the selected and hovered ones can be drawn on their own
  const edgeBuf = gl.createBuffer()!;
  let edges: EdgeLike[] = [];
  let edgeRanges = new Map<number, { first: number; count: number }>();
  let selEdges: number[] = [];
  let hoverEdgeExt: number | null = null;   // a dialog row (hoverEdge)
  let filter: PickFilter = 'both';
  // what a click at the pointer would pick, lit while hovering
  let hoverPick: { edge: number } | { face: number } | { plane: string } | null = null;
  // construction planes: each a fill (a 4-vertex strip) and an outline (4
  // thick segments) in two buffers, rebuilt when the planes or the part change
  let planes: PlaneShape[] = [];
  let selPlanes: string[] = [];
  let hoverPlaneExt: string | null = null;   // a label or a list row (hoverPlane)
  const planeFillBuf = gl.createBuffer()!;
  const planeEdgeBuf = gl.createBuffer()!;
  let planeGeo: { name: string; corners: Vec3[]; preview: boolean }[] = [];
  let planeGeoStale = true;
  const CPLANE: Vec3 = [0.62, 0.44, 0.94];        // violet: not a face, the selection or the section
  const CPLANE_HOVER: Vec3 = [0.78, 0.66, 1.0];
  const CPLANE_PREVIEW: Vec3 = [0.36, 0.72, 0.86]; // a dialog's preview (OpDialogs PREVIEW_COLOR)
  function planeGeometry() {
    if (!planeGeoStale) return planeGeo;
    const m = modelRadius * 0.12;
    planeGeo = planes.map((p) => ({ name: p.name, corners: planeCorners(p, modelMin, modelMax, m), preview: !!p.preview }));
    const fill: number[] = [], line: number[] = [];
    for (const g of planeGeo) {
      const c = g.corners;
      fill.push(...c[0]!, ...c[1]!, ...c[3]!, ...c[2]!);   // a strip
      line.push(...outlineSegments(c));
    }
    gl!.bindBuffer(gl!.ARRAY_BUFFER, planeFillBuf);
    gl!.bufferData(gl!.ARRAY_BUFFER, new Float32Array(fill), gl!.DYNAMIC_DRAW);
    gl!.bindBuffer(gl!.ARRAY_BUFFER, planeEdgeBuf);
    gl!.bufferData(gl!.ARRAY_BUFFER, thickVerts(line), gl!.DYNAMIC_DRAW);
    planeGeoStale = false;
    return planeGeo;
  }
  // the plane whose outline (or label corner) is within a few px of the pointer
  function planeAt(px: number, py: number): string | null {
    if (!planes.length) return null;
    const toCss = cssProjector();
    let best: string | null = null, bestD = EDGE_PX;
    for (const g of planeGeometry()) {
      if (g.preview) continue;
      const pts = g.corners.map((c) => toCss(c));
      for (let i = 0; i < 4; i++) {
        const a = pts[i]!, b = pts[(i + 1) % 4]!;
        if (!a[2] || !b[2]) continue;
        const { d } = segmentDistance(px, py, [a[0], a[1]], [b[0], b[1]]);
        if (d < bestD) { bestD = d; best = g.name; }
      }
    }
    return best;
  }

  // coordinate frame: a ground grid on the engine's Z=0 plane. Orientation
  // (which way is +X/+Y/+Z) is shown by the corner gizmo, not axis lines.
  const gridBuf = gl.createBuffer()!;
  let gridCount = 0;
  function buildFrame(radius: number) {
    const pow = Math.pow(10, Math.floor(Math.log10(radius / 4)));
    const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => radius / s <= 6) ?? 10 * pow;
    const n = Math.ceil((radius * 1.2) / step);
    const ext = n * step;
    const g: number[] = [];
    for (let i = -n; i <= n; i++) {
      g.push(i * step, -ext, 0, i * step, ext, 0);   // lines along Y
      g.push(-ext, i * step, 0, ext, i * step, 0);   // lines along X
    }
    gl!.bindBuffer(gl!.ARRAY_BUFFER, gridBuf);
    gl!.bufferData(gl!.ARRAY_BUFFER, new Float32Array(g), gl!.STATIC_DRAW);
    gridCount = g.length / 3;
  }

  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);  // so re-drawing a selected face's own triangles passes
  gl.clearColor(0, 0, 0, 0);

  // orbit state: q rotates world → view; `anim` eases it to a new view
  const FOVY = (45 * Math.PI) / 180;
  const VIEW_MS = 200;
  let q: Quat = lookFrom(VIEW_DIRS.iso);
  let anim: { from: Quat; to: Quat; t0: number } | null = null;
  let orthographic = false;
  let distance = 5;
  let center: [number, number, number] = [0, 0, 0];
  let vertexCount = 0;
  // NDC lens shift: keeps the picture still while the canvas moves at the
  // start of a sketch-mode transition, then eases to 0
  let lens: [number, number] = [0, 0];
  // CSS px along the left of the canvas covered by a dialog: the picture is
  // drawn centred (and a little smaller) in the rest
  let inset = 0;
  const TAN_HALF = Math.tan(FOVY / 2);

  // sketch mode: the plane being sketched on, the view to return to, and the
  // transition (pose + dim + clip eased together)
  type Pose = { q: Quat; center: Vec3; distance: number; lens: [number, number] };
  let sketch: { plane: PlaneBasis; face: number; bg: [number, number, number];
                phase: 'enter' | 'on' | 'exit' } | null = null;
  let saved: { q: Quat; center: Vec3; distance: number; orthographic: boolean } | null = null;
  let camAnim: { from: Pose; to: Pose; t0: number; dim: [number, number]; clip: [number, number] } | null = null;
  const SKETCH_MS = 250;
  let sketchClip = 0;        // clipD while sketching (huge: a base plane, nothing cut)
  // an extrude preview, drawn from ghostBuf; while it shows, the sketch's
  // camera is kept in sketchPose for the turn back
  const ghostBuf = gl.createBuffer()!;
  let ghost: { edges: number; arrows: number; color: Vec3 } | null = null;
  let sketchPose: { center: Vec3; distance: number } | null = null;
  let dimK = 0;              // 0 normal … 1 fully dimmed
  let clipD = Infinity;      // cut away beyond plane offset + clipD
  let lastRect: DOMRect | null = null;   // the canvas's page rect at the last render

  // face selection
  let meshPositions: number[] = [];
  let faces: FaceRange[] = [];
  let faceByIndex = new Map<number, FaceRange>();
  let selected: number[] = [];
  let dims: DimAnchor[] = [];
  let modelRadius = 40;
  let modelCenter: Vec3 = [0, 0, 0];
  let modelMin: Vec3 = [-40, -40, -40], modelMax: Vec3 = [40, 40, 40];
  let thumbMode = false;   // when capturing a thumbnail: draw the solid only (no grid/overlays)
  // the overhang highlight (setOverhangs); bed: the lowest level along down, of the part / candidate
  let ov: { down: Vec3; threshold: number; bed: number; candBed: number } | null = null;
  const SELECT: [number, number, number] = [1.0, 0.62, 0.2];
  const SNAP: [number, number, number] = [0.18, 0.83, 0.75];

  // drag handle: dragging it previews the face moved by shift*t (no rebuild);
  // on release the new value goes to onHandleDrop and the preview stays up
  // (`pending`) until the rebuild replaces the mesh
  let handle: DragHandle | null = null;
  let drag: {
    x0: number; y0: number;     // pointer-down, client px
    t: number;                  // param change at the current position
    value: number;              // handle.value + t
    snap: number | null;        // face whose plane it snapped to
    motion: Float32Array;       // per-vertex world motion per unit (faceMotion)
    pending: boolean;           // released, waiting for the rebuild
  } | null = null;
  const handleArm = () => modelRadius * 0.22;   // drawn arrow length (world)

  // the section view (setSection): the plane, and for the part and for an
  // operation's preview the vertex dots along its dir (kept while it only
  // moves) and the outline at its offset
  let section: Section | null = null;
  interface Cut {
    pos: ArrayLike<number>; nrm: ArrayLike<number>;
    dir: Vec3 | null; dots: Float32Array | null;
    offset: number; outline: Outline | null; uploaded: boolean;
  }
  const newCut = (pos: ArrayLike<number>, nrm: ArrayLike<number>): Cut =>
    ({ pos, nrm, dir: null, dots: null, offset: NaN, outline: null, uploaded: false });
  let partCut = newCut([], []);
  let candCut = newCut([], []);
  function cutOutline(c: Cut, s: Section): Outline {
    if (!c.dots || !c.dir || c.dir[0] !== s.dir[0] || c.dir[1] !== s.dir[1] || c.dir[2] !== s.dir[2]) {
      c.dots = vertexDots(c.pos, s.dir);
      c.dir = s.dir;
      c.outline = null;
    }
    if (!c.outline || c.offset !== s.offset) {
      c.outline = buildOutline(c.pos, c.nrm, c.dots, s.dir, s.offset);
      c.offset = s.offset;
      c.uploaded = false;
    }
    return c.outline;
  }
  const outlineBuf = gl.createBuffer()!;
  let outlineFrom: Cut | null = null;   // which cut outlineBuf holds
  const capBuf = gl.createBuffer()!;      // the plane's rectangle, a strip (the cap)
  const planeBuf = gl.createBuffer()!;    // …and its outline, lines
  const measBuf = gl.createBuffer()!;     // the measure lines
  // the part's bodies, for capping each on its own (a tint each): faces
  // joined by edges are one body; a body wound inside out counts the other way
  type CapGroup = { tint: Vec3; bodies: { ranges: [number, number][]; inverted: boolean }[] };
  let capGroups: CapGroup[] | null = null;
  const CAP_TINTS: Vec3[] = [[0.80, 0.36, 0.33], [0.76, 0.47, 0.30], [0.70, 0.34, 0.47], [0.84, 0.44, 0.40]];
  const OUTLINE: Vec3 = [0.24, 0.07, 0.06];
  const PLANE_LINE: Vec3 = [0.5, 0.56, 0.64];
  let triFace = new Int32Array(0);   // each triangle's face (its place in `faces`), -1 none
  // dragging the plane along its dir: like a handle drag, but nothing rebuilds
  let secDrag: { x0: number; y0: number; offset0: number; snap: number | null } | null = null;
  // measuring: the wall under the pointer; points clicked on the outline
  let secHover: { a: Vec3; b: Vec3; mm: number; approx: boolean } | null = null;
  let secPts: { p: Vec3; approx: boolean }[] = [];
  const activeSection = (): Section | null => (section && !sketch && vertexCount ? section : null);

  // the part's bodies in order (the first face's first), each its vertex
  // ranges; also shades each body its own colour (bodyColors)
  let bodyList: { ranges: [number, number][]; vol: number }[] | null = null;
  function partBodies(): { ranges: [number, number][]; vol: number }[] {
    if (bodyList) return bodyList;
    if (!faces.length) {
      return bodyList = [{ ranges: [[0, vertexCount]], vol: signedVolume6(meshPositions, 0, vertexCount) }];
    }
    const at = new Map(faces.map((f, i) => [f.index, i]));
    const body = faceBodies(faces.length, edges.map((e) => ({ faceIndices: e.faceIndices.map((i) => at.get(i) ?? -1) })));
    const out: { ranges: [number, number][]; vol: number }[] = [];
    faces.forEach((f, i) => {
      const e = out[body[i]!] ??= { ranges: [], vol: 0 };
      const last = e.ranges[e.ranges.length - 1];
      if (last && last[0] + last[1] === f.start) last[1] += f.count;   // contiguous: one draw
      else e.ranges.push([f.start, f.count]);
      e.vol += signedVolume6(meshPositions, f.start, f.count);
    });
    return bodyList = out;
  }

  function partCapGroups(): CapGroup[] {
    if (capGroups) return capGroups;
    const groups: CapGroup[] = [];
    partBodies().forEach((e, b) => {
      const g = b % CAP_TINTS.length;
      groups[g] ??= { tint: CAP_TINTS[g]!, bodies: [] };
      groups[g]!.bodies.push({ ranges: e.ranges, inverted: e.vol < 0 });
    });
    return capGroups = groups.filter(Boolean);
  }

  // the plane's rectangle: the part's box seen square-on, with a margin
  function planeRect(s: Section): Vec3[] {
    const [u, v] = planeBasis(s.dir);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      const c: Vec3 = [i & 1 ? modelMax[0] : modelMin[0], i & 2 ? modelMax[1] : modelMin[1], i & 4 ? modelMax[2] : modelMin[2]];
      const a = dot(c, u), b = dot(c, v);
      u0 = Math.min(u0, a); u1 = Math.max(u1, a); v0 = Math.min(v0, b); v1 = Math.max(v1, b);
    }
    const m = modelRadius * 0.08;
    const w = scale(s.dir, s.offset);
    const at = (a: number, b: number) => add(add(scale(u, a), scale(v, b)), w);
    return [at(u0 - m, v0 - m), at(u1 + m, v0 - m), at(u0 - m, v1 + m), at(u1 + m, v1 + m)];
  }

  // the pixel ray (CSS px) meets the plane: the world point, or null
  function onPlaneAt(px: number, py: number, s: Section): Vec3 | null {
    const { proj, view, model } = mvp(canvas.width, canvas.height);
    const inv = invert(multiply(proj, multiply(view, model)));
    if (!inv) return null;
    const nx = (px / canvas.clientWidth) * 2 - 1, ny = 1 - (py / canvas.clientHeight) * 2;
    const un = (z: number): Vec3 => {
      const x = inv[0]! * nx + inv[4]! * ny + inv[8]! * z + inv[12]!;
      const y = inv[1]! * nx + inv[5]! * ny + inv[9]! * z + inv[13]!;
      const zz = inv[2]! * nx + inv[6]! * ny + inv[10]! * z + inv[14]!;
      const w = inv[3]! * nx + inv[7]! * ny + inv[11]! * z + inv[15]!;
      return [x / w, y / w, zz / w];
    };
    const a = un(-1), b = un(1);
    const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const den = dot(d, s.dir);
    if (Math.abs(den) < 1e-12) return null;
    const t = (s.offset - dot(a, s.dir)) / den;
    return t < 0 || t > 1 ? null : add(a, scale(d, t));
  }

  // the camera looks at the cut face (not at the part's kept outside)
  function seesCut(s: Section): boolean {
    const rot = quatToMat4(q);
    const back: Vec3 = [rot[2]!, rot[6]!, rot[10]!];
    if (orthographic) return dot(back, cutNormal(s)) > 0;
    return cutDepth(s, add(center, scale(back, distance))) > 0;
  }

  // CSS px per mm on the plane at p
  function pxPerMm(p: Vec3, o: Outline): number {
    const toCss = cssProjector();
    const [x0, y0] = toCss(p);
    const [x1, y1] = toCss(add(p, o.basis[0]));
    return Math.max(Math.hypot(x1 - x0, y1 - y0), 1e-6);
  }

  const segApprox = (o: Outline, seg: number): boolean => {
    const fi = triFace[o.tri[seg]!] ?? -1;
    return fi < 0 || faces[fi]?.kind !== 'plane';
  };

  // the nearest outline point to the pointer, within tolPx (or anywhere, on the cap)
  function outlineAt(px: number, py: number, tolPx: number, onCap: boolean) {
    const s = activeSection();
    if (!s || cand || !seesCut(s)) return null;
    const o = cutOutline(partCut, s);
    const P = onPlaneAt(px, py, s);
    if (!P || !o.count) return null;
    const qq = toPlane(o, P);
    const inside = onCap && insideOutline(o, qq);
    const near = nearestSegment(o, qq, inside ? Infinity : tolPx / pxPerMm(P, o));
    return near ? { s, o, near, inside } : null;
  }

  // hover: the wall's thickness across the cap at the pointer; true when the
  // pointer is on the cut (so nothing else is hovered)
  function measureAt(px: number, py: number): boolean {
    const r = outlineAt(px, py, 6, true);
    const was = secHover;
    secHover = null;
    if (r) {
      const w = wallThickness(r.o, r.near.seg, r.near.p);
      if (w) {
        secHover = { a: fromPlane(r.o, r.s, r.near.p), b: fromPlane(r.o, r.s, w.to), mm: w.mm,
                     approx: segApprox(r.o, r.near.seg) || segApprox(r.o, w.seg) };
      }
    }
    if (was || secHover) scheduleRender();
    return !!r;
  }
  function uploadMesh(mesh: ViewerMesh) {
    gl!.bindBuffer(gl!.ARRAY_BUFFER, posBuf);
    gl!.bufferData(gl!.ARRAY_BUFFER, new Float32Array(mesh.positions), gl!.STATIC_DRAW);
    gl!.bindBuffer(gl!.ARRAY_BUFFER, normBuf);
    gl!.bufferData(gl!.ARRAY_BUFFER, new Float32Array(mesh.normals), gl!.STATIC_DRAW);
    vertexCount = mesh.positions.length / 3;
    if (vertexCount === 0) {  // empty build — still show the coordinate frame
      center = [0, 0, 0]; buildFrame(40);
      distance = 48 / Math.tan((45 * Math.PI) / 180 / 2) * 1.4;
      return;
    }

    // frame the camera on the bounding box
    const xs = mesh.positions;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < xs.length; i += 3) {
      minX = Math.min(minX, xs[i]!); maxX = Math.max(maxX, xs[i]!);
      minY = Math.min(minY, xs[i + 1]!); maxY = Math.max(maxY, xs[i + 1]!);
      minZ = Math.min(minZ, xs[i + 2]!); maxZ = Math.max(maxZ, xs[i + 2]!);
    }
    center = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
    const radius = Math.max(
      Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2,
      0.001,
    );
    distance = radius / Math.tan((45 * Math.PI) / 180 / 2) * 1.4;
    modelRadius = radius;
    modelCenter = center;
    modelMin = [minX, minY, minZ];
    modelMax = [maxX, maxY, maxZ];
    planeGeoStale = true;
    buildFrame(radius);
  }

  function mvp(w: number, h: number) {
    // ortho shows the same size as perspective does at the orbit centre
    const halfH = distance * TAN_HALF;
    let proj = orthographic
      ? ortho(halfH * (w / h), halfH, -distance * 100, distance * 100)
      : perspective(FOVY, w / h, distance * 0.01, distance * 100);
    if (lens[0] || lens[1]) proj = multiply(translation(lens[0], lens[1], 0), proj);
    if (inset > 0) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const f = Math.min((inset * dpr) / w, 0.6);    // the covered share of the width
      const k = Math.max(1 - f, 0.55);
      const s = identity();
      s[0] = k; s[5] = k;
      proj = multiply(translation(f, 0, 0), multiply(s, proj));
    }
    const view = translation(0, 0, -distance);
    const rot = quatToMat4(q);
    const model = multiply(rot, translation(-center[0], -center[1], -center[2]));
    return { proj, view, model, rot };
  }

  // screen-space pick: project every triangle, return the face under (px,py)
  function pick(px: number, py: number): FaceRange | null {
    return hitAt(px, py)?.face ?? null;
  }

  // the frontmost face under (px, py) CSS px, and its NDC depth there. With
  // a section, what is cut away isn't there, and the cap (face null) is
  function hitAt(px: number, py: number): { face: FaceRange | null; depth: number; point?: Vec3; tri?: number } | null {
    if (!vertexCount || faces.length === 0) return null;
    const sec = activeSection();
    const w = canvas.width, h = canvas.height;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const sx = px * dpr, sy = py * dpr;
    const { proj, view, model } = mvp(w, h);
    const pv = multiply(proj, multiply(view, model));
    const project = (i: number): [number, number, number, number] | null => {
      const x = meshPositions[i * 3]!, y = meshPositions[i * 3 + 1]!, z = meshPositions[i * 3 + 2]!;
      const cw = pv[3]! * x + pv[7]! * y + pv[11]! * z + pv[15]!;
      if (cw <= 0) return null;
      const cx = pv[0]! * x + pv[4]! * y + pv[8]! * z + pv[12]!;
      const cy = pv[1]! * x + pv[5]! * y + pv[9]! * z + pv[13]!;
      const cz = pv[2]! * x + pv[6]! * y + pv[10]! * z + pv[14]!;
      return [(cx / cw * 0.5 + 0.5) * w, (1 - (cy / cw * 0.5 + 0.5)) * h, cz / cw, cw];
    };
    const depthIn = (i: number) => (sec
      ? cutDepth(sec, [meshPositions[i * 3]!, meshPositions[i * 3 + 1]!, meshPositions[i * 3 + 2]!]) : 0);
    let bestDepth = Infinity, bestFace: FaceRange | null = null;
    // the hit triangle's first vertex and perspective-correct weights of its three
    let bestAt: { v: number; k: [number, number, number] } | null = null;
    for (const f of faces) {
      for (let v = f.start; v < f.start + f.count; v += 3) {
        const a = project(v), b = project(v + 1), c = project(v + 2);
        if (!a || !b || !c) continue;
        // barycentric point-in-triangle in screen space
        const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
        if (Math.abs(d) < 1e-6) continue;
        const u = ((b[1] - c[1]) * (sx - c[0]) + (c[0] - b[0]) * (sy - c[1])) / d;
        const w2 = ((c[1] - a[1]) * (sx - c[0]) + (a[0] - c[0]) * (sy - c[1])) / d;
        const t = 1 - u - w2;
        if (u < 0 || w2 < 0 || t < 0) continue;
        const depth = u * a[2] + w2 * b[2] + t * c[2];
        if (depth >= bestDepth) continue;
        if (sec) {
          // how far into the cut side the point is (perspective-correct)
          const k = u / a[3] + w2 / b[3] + t / c[3];
          const s = (u * depthIn(v) / a[3] + w2 * depthIn(v + 1) / b[3] + t * depthIn(v + 2) / c[3]) / k;
          if (s > 1e-4) continue;
        }
        bestDepth = depth; bestFace = f;
        const k = u / a[3] + w2 / b[3] + t / c[3];
        bestAt = { v, k: [u / a[3] / k, w2 / b[3] / k, t / c[3] / k] };
      }
    }
    if (sec) {
      // the cap, in front of what was hit
      const P = onPlaneAt(px, py, sec);
      if (P) {
        const o = cutOutline(partCut, sec);
        const cw = pv[3]! * P[0] + pv[7]! * P[1] + pv[11]! * P[2] + pv[15]!;
        const cz = pv[2]! * P[0] + pv[6]! * P[1] + pv[10]! * P[2] + pv[14]!;
        if (cw > 0 && cz / cw < bestDepth && insideOutline(o, toPlane(o, P))) return { face: null, depth: cz / cw };
      }
    }
    if (!bestFace) return null;
    const at = (j: number) => [0, 1, 2].reduce((sum, i) => sum + bestAt!.k[i]! * meshPositions[(bestAt!.v + i) * 3 + j]!, 0);
    return { face: bestFace, depth: bestDepth, point: bestAt ? [at(0), at(1), at(2)] : undefined, tri: bestAt ? bestAt.v / 3 : undefined };
  }

  // world → [CSS x, CSS y, NDC depth] (null: behind the camera)
  function ndcProjector() {
    const { proj, view, model, rot } = mvp(canvas.width, canvas.height);
    const pv = multiply(proj, multiply(view, model));
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    const toCss = (p: Vec3): [number, number, number] | null => {
      const [x, y, z] = p;
      const clw = pv[3]! * x + pv[7]! * y + pv[11]! * z + pv[15]!;
      if (clw <= 0) return null;
      const cx = pv[0]! * x + pv[4]! * y + pv[8]! * z + pv[12]!;
      const cy = pv[1]! * x + pv[5]! * y + pv[9]! * z + pv[13]!;
      const cz = pv[2]! * x + pv[6]! * y + pv[10]! * z + pv[14]!;
      return [(cx / clw * 0.5 + 0.5) * cw, (1 - (cy / clw * 0.5 + 0.5)) * ch, cz / clw];
    };
    // toward the viewer from p: to the eye (perspective), or along the view axis
    const back: Vec3 = [rot[2]!, rot[6]!, rot[10]!];
    const eye = add(center, scale(back, distance));
    const toward = (p: Vec3): Vec3 => {
      if (orthographic) return back;
      const d: Vec3 = [eye[0] - p[0], eye[1] - p[1], eye[2] - p[2]];
      const l = Math.hypot(...d) || 1;
      return [d[0] / l, d[1] / l, d[2] / l];
    };
    return { toCss, toward };
  }

  // an edge candidate is visible when nothing of the part is in front of it:
  // its nearest point, nudged toward the viewer (off its own faces), is at
  // least as near as the frontmost triangle at that pixel
  function edgeVisible(c: EdgeCandidate, P: ReturnType<typeof ndcProjector>): boolean {
    const e = edges.find((x) => x.index === c.index);
    const a = e?.polyline[c.seg], b = e?.polyline[c.seg + 1];
    if (!a || !b) return false;
    const p: Vec3 = [a[0] + (b[0] - a[0]) * c.t, a[1] + (b[1] - a[1]) * c.t, a[2] + (b[2] - a[2]) * c.t];
    const tol = Math.max(0.15, modelRadius * 0.004);
    const q2 = P.toCss(add(p, scale(P.toward(p), tol)));
    if (!q2) return false;
    const hit = hitAt(q2[0], q2[1]);
    return !hit || hit.depth >= q2[2];
  }

  // what a click at (px, py) CSS px picks, under the filter
  function pickAt(px: number, py: number): ViewerPick {
    const onPlane = filter === 'both' ? planeAt(px, py) : null;
    if (onPlane) return { plane: onPlane };
    const P = ndcProjector();
    let near: EdgeCandidate[] = [];
    if (filter !== 'faces' && edges.length) {
      const sec = activeSection();
      const screen: ScreenEdge[] = edges.filter(selectable).map((e) => ({
        index: e.index, pts: e.polyline.map((p) => {
          if (sec && cutDepth(sec, p) > 1e-4) return null;   // cut away
          const s = P.toCss(p);
          return s ? [s[0], s[1]] as [number, number] : null;
        }),
      }));
      near = edgesNear(screen, px, py);
    }
    const hit = filter !== 'edges' ? hitAt(px, py) : null;
    const face = hit?.face ?? null;
    const p = choosePick(near, face?.index ?? null, filter, (c) => edgeVisible(c, P), new Set(selEdges));
    if (!p) return null;
    if ('edge' in p) return p;
    return face ? { face, ...(hit?.point ? { point: hit.point } : {}) } : null;
  }

  // world → CSS px in the canvas, for the HTML overlays and handle hit-testing
  function cssProjector() {
    const { proj, view, model } = mvp(canvas.width, canvas.height);
    const pv = multiply(proj, multiply(view, model));
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    return (p: Vec3): [number, number, boolean] => {
      const [x, y, z] = p;
      const clw = pv[3]! * x + pv[7]! * y + pv[11]! * z + pv[15]!;
      if (clw <= 0) return [0, 0, false];
      const cx = pv[0]! * x + pv[4]! * y + pv[8]! * z + pv[12]!;
      const cy = pv[1]! * x + pv[5]! * y + pv[9]! * z + pv[13]!;
      return [(cx / clw * 0.5 + 0.5) * cw, (1 - (cy / clw * 0.5 + 0.5)) * ch, true];
    };
  }

  // the handle in screen space: anchor (moved by the drag) → arrow tip
  const handleBase = (): Vec3 | null =>
    handle ? handle.at ?? faceByIndex.get(handle.face)?.center ?? null : null;
  function placeHandle(toCss: (p: Vec3) => [number, number, boolean]): PlacedHandle | null {
    const base = handleBase();
    if (!handle || !base) return null;
    // a point handle sits its value out from its point (it moves no face to carry it)
    const off = handle.at ? (drag ? drag.value : handle.value) : (drag ? drag.t : 0);
    let p = add(base, scale(handle.shift, off));
    let tip = add(p, scale(handle.shift, handleArm() / Math.hypot(...handle.shift)));
    if (handle.turn) {
      // round the axis: the knob on the arm at the angle, the arrow the way + turns
      const r = (off * Math.PI) / 180, { w, n } = handle.turn, arm = Math.max(handleArm(), handle.turn.arm ?? 0);
      p = add(base, add(scale(w, arm * Math.cos(r)), scale(n, arm * Math.sin(r))));
      tip = add(p, add(scale(w, -0.6 * arm * Math.sin(r)), scale(n, 0.6 * arm * Math.cos(r))));
    }
    const [x, y, v1] = toCss(p);
    const [ax, ay, v2] = toCss(tip);
    const sec = activeSection();
    const cut = !!sec && cutDepth(sec, base) > 1e-3;   // its face is cut away
    return {
      x, y, ax, ay, visible: v1 && v2 && !cut, dragging: !!drag,
      value: drag ? drag.value : handle.value, snapFace: drag ? drag.snap : null,
    };
  }

  // the section plane's arrow: from the plane's middle, into the cut side
  function placeSecHandle(toCss: (p: Vec3) => [number, number, boolean]): PlacedHandle | null {
    const s = activeSection();
    if (!s) return null;
    const p = planePoint(s, modelCenter);
    const [x, y, v1] = toCss(p);
    const [ax, ay, v2] = toCss(add(p, scale(cutNormal(s), handleArm())));
    return { x, y, ax, ay, visible: v1 && v2, dragging: !!secDrag, value: s.offset, snapFace: secDrag?.snap ?? null };
  }

  let raf = 0;
  function scheduleRender() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; render(); });
  }

  function render() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl!.viewport(0, 0, w, h);
    if (anim && !thumbMode) {
      const k = Math.min(1, (performance.now() - anim.t0) / VIEW_MS);
      q = slerp(anim.from, anim.to, easeInOutCubic(k));
      if (k < 1) scheduleRender(); else anim = null;
    }
    if (camAnim && !thumbMode) stepCamAnim();
    lastRect = canvas.getBoundingClientRect();
    gl!.clear(gl!.COLOR_BUFFER_BIT | gl!.DEPTH_BUFFER_BIT);
    // draw even with no solid, so the coordinate frame is always visible

    const { proj, view, model, rot } = mvp(w, h);

    gl!.useProgram(prog);
    gl!.uniformMatrix4fv(uProj, false, proj);
    gl!.uniformMatrix4fv(uView, false, view);
    gl!.uniformMatrix4fv(uModel, false, model);
    gl!.uniformMatrix3fv(uNormal, false, mat3Of(rot));
    gl!.uniform3fv(uColor, color);
    gl!.uniform1f(uAlpha, 1);
    const sk = thumbMode ? null : sketch;
    if (sk && Number.isFinite(clipD)) {
      const n = sk.plane.normal;
      gl!.uniform4f(uClip, n[0], n[1], n[2], dot3(n, sk.plane.origin) + clipD);
    } else {
      gl!.uniform4f(uClip, 0, 0, 0, 1);   // 0 > 1 never: nothing cut
    }
    gl!.uniform1f(uDim, sk ? dimK : 0);
    gl!.uniform3fv(uBg, sk ? sk.bg : [0, 0, 0]);
    // the section (never in a thumbnail, nor while sketching)
    const sec = thumbMode ? null : activeSection();
    const secPlane = sec ? shaderPlane(sec) : null;
    const setSec = (loc: WebGLUniformLocation | null, onLoc: WebGLUniformLocation | null, on: boolean) => {
      if (on && secPlane) gl!.uniform4f(loc, secPlane[0], secPlane[1], secPlane[2], secPlane[3]);
      gl!.uniform1f(onLoc, on && secPlane ? 1 : 0);
    };
    setSec(uSec, uSecOn, true);
    // overhangs: on the part (or candidate) itself, never its overlays
    const ovOn = !!ov && !sk && !thumbMode;
    const setOv = (on: boolean, bed = ov?.bed ?? 0, flip = false) => {
      gl!.uniform1f(uOvOn, on && ovOn ? 1 : 0);
      if (!on || !ovOn) return;
      const t = (ov!.threshold * Math.PI) / 180;
      gl!.uniform3fv(uDown, ov!.down);
      gl!.uniform4f(uOv, Math.sin(t), Math.sin((CEILING_DEG * Math.PI) / 180), t, bed);
      gl!.uniform1f(uFlip, flip ? -1 : 1);
    };
    setOv(false);

    gl!.bindBuffer(gl!.ARRAY_BUFFER, posBuf);
    gl!.enableVertexAttribArray(aPos);
    gl!.vertexAttribPointer(aPos, 3, gl!.FLOAT, false, 0, 0);
    gl!.bindBuffer(gl!.ARRAY_BUFFER, normBuf);
    gl!.enableVertexAttribArray(aNormal);
    gl!.vertexAttribPointer(aNormal, 3, gl!.FLOAT, false, 0, 0);

    // while a handle drag is previewed, its face is drawn moved (below), so
    // leave it out of the solid
    const df = drag && handle && !handle.at && !thumbMode ? faceByIndex.get(handle.face) ?? null : null;
    const showCand = cand && !thumbMode && !sketch;
    if (showCand) {
      gl!.bindBuffer(gl!.ARRAY_BUFFER, candPosBuf);
      gl!.vertexAttribPointer(aPos, 3, gl!.FLOAT, false, 0, 0);
      gl!.bindBuffer(gl!.ARRAY_BUFFER, candNormBuf);
      gl!.vertexAttribPointer(aNormal, 3, gl!.FLOAT, false, 0, 0);
      gl!.uniform3fv(uColor, cand!.color);
      setOv(true, ov?.candBed, cand!.inverted);
      if (cand!.count) gl!.drawArrays(gl!.TRIANGLES, 0, cand!.count);
      setOv(false);
      if (candExtra?.count) {
        // over the candidate where they coincide (pulled toward the eye a little)
        gl!.bindBuffer(gl!.ARRAY_BUFFER, extraPosBuf);
        gl!.vertexAttribPointer(aPos, 3, gl!.FLOAT, false, 0, 0);
        gl!.bindBuffer(gl!.ARRAY_BUFFER, extraNormBuf);
        gl!.vertexAttribPointer(aNormal, 3, gl!.FLOAT, false, 0, 0);
        gl!.uniform3fv(uColor, candExtra.color);
        gl!.enable(gl!.POLYGON_OFFSET_FILL);
        gl!.polygonOffset(-1, -2);
        gl!.drawArrays(gl!.TRIANGLES, 0, candExtra.count);
        gl!.disable(gl!.POLYGON_OFFSET_FILL);
      }
      gl!.uniform3fv(uColor, color);
      // the part's selected / hovered faces show through it (x-ray)
      const lit = [...selected.map((i) => [i, SELECT] as const), ...(hovered !== null ? [[hovered, HOVER] as const] : [])];
      if (lit.length) {
        gl!.bindBuffer(gl!.ARRAY_BUFFER, posBuf);
        gl!.vertexAttribPointer(aPos, 3, gl!.FLOAT, false, 0, 0);
        gl!.bindBuffer(gl!.ARRAY_BUFFER, normBuf);
        gl!.vertexAttribPointer(aNormal, 3, gl!.FLOAT, false, 0, 0);
        gl!.disable(gl!.DEPTH_TEST);
        gl!.enable(gl!.BLEND);
        gl!.blendFuncSeparate(gl!.SRC_ALPHA, gl!.ONE_MINUS_SRC_ALPHA, gl!.ZERO, gl!.ONE);  // keep canvas alpha
        for (const [i, col] of lit) {
          const f = faceByIndex.get(i);
          if (!f) continue;
          gl!.uniform3fv(uColor, col);
          gl!.uniform1f(uAlpha, i === hovered ? 0.75 : 0.45);
          gl!.drawArrays(gl!.TRIANGLES, f.start, f.count);
        }
        gl!.uniform1f(uAlpha, 1);
        gl!.disable(gl!.BLEND);
        gl!.enable(gl!.DEPTH_TEST);
        gl!.uniform3fv(uColor, color);
      }
    } else if (vertexCount) {
      // one solid: the part's colour; more: each body shaded a little apart
      const bodies = thumbMode ? null : partBodies();
      const list = bodies && bodies.length > 1 ? bodies : [{ ranges: [[0, vertexCount]] as [number, number][] }];
      list.forEach((b, i) => {
        if (list.length > 1) gl!.uniform3fv(uColor, bodyColor(color, i));
        setOv(true, ov?.bed, (bodies?.[i]?.vol ?? 0) < 0);
        for (const [a, c] of df ? rangesWithout(b.ranges, df.start, df.count) : b.ranges) gl!.drawArrays(gl!.TRIANGLES, a, c);
      });
      setOv(false);
      gl!.uniform3fv(uColor, color);
    }

    // the section's caps: per group of bodies, count the kept surfaces behind
    // (or in front of) the plane in the stencil — back faces up, front faces
    // down; where the count isn't 0 the plane is inside the solid — then fill
    // the plane's rectangle there
    if (sec && hasStencil && (showCand ? cand!.count : vertexCount)) {
      const rect = planeRect(sec);
      const strip = new Float32Array(12);
      rect.forEach((c, i) => strip.set(c, i * 3));
      gl!.bindBuffer(gl!.ARRAY_BUFFER, capBuf);
      gl!.bufferData(gl!.ARRAY_BUFFER, strip, gl!.DYNAMIC_DRAW);
      const groups: CapGroup[] = showCand
        ? [{ tint: CAP_TINTS[0]!, bodies: [{ ranges: [[0, cand!.count]], inverted: cand!.inverted }] }]
        : partCapGroups();
      const pvm = multiply(proj, multiply(view, model));
      gl!.enable(gl!.STENCIL_TEST);
      for (const g of groups) {
        gl!.clear(gl!.STENCIL_BUFFER_BIT);
        gl!.useProgram(prog);
        gl!.bindBuffer(gl!.ARRAY_BUFFER, showCand ? candPosBuf : posBuf);
        gl!.enableVertexAttribArray(aPos);
        gl!.vertexAttribPointer(aPos, 3, gl!.FLOAT, false, 0, 0);
        gl!.bindBuffer(gl!.ARRAY_BUFFER, showCand ? candNormBuf : normBuf);
        gl!.enableVertexAttribArray(aNormal);
        gl!.vertexAttribPointer(aNormal, 3, gl!.FLOAT, false, 0, 0);
        gl!.colorMask(false, false, false, false);
        gl!.depthMask(false);
        gl!.disable(gl!.DEPTH_TEST);
        gl!.stencilFunc(gl!.ALWAYS, 0, 0xff);
        for (const b of g.bodies) {
          const up = b.inverted ? gl!.DECR_WRAP : gl!.INCR_WRAP, down = b.inverted ? gl!.INCR_WRAP : gl!.DECR_WRAP;
          gl!.stencilOpSeparate(gl!.BACK, gl!.KEEP, gl!.KEEP, up);
          gl!.stencilOpSeparate(gl!.FRONT, gl!.KEEP, gl!.KEEP, down);
          for (const [first, n] of b.ranges) gl!.drawArrays(gl!.TRIANGLES, first, n);
        }
        gl!.colorMask(true, true, true, true);
        gl!.depthMask(true);
        gl!.enable(gl!.DEPTH_TEST);
        gl!.stencilFunc(gl!.NOTEQUAL, 0, 0xff);
        gl!.stencilOp(gl!.KEEP, gl!.KEEP, gl!.KEEP);
        gl!.disableVertexAttribArray(aNormal);
        gl!.useProgram(capProg);
        gl!.uniformMatrix4fv(cPV, false, pvm);
        gl!.uniform3fv(cColor, g.tint);
        gl!.uniform1f(cHatch, 9 * dpr);
        gl!.uniform1f(cLine, 1.1 * dpr);
        gl!.bindBuffer(gl!.ARRAY_BUFFER, capBuf);
        gl!.enableVertexAttribArray(cPos);
        gl!.vertexAttribPointer(cPos, 3, gl!.FLOAT, false, 0, 0);
        gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4);
      }
      gl!.disable(gl!.STENCIL_TEST);
      // back to the part
      gl!.useProgram(prog);
      gl!.bindBuffer(gl!.ARRAY_BUFFER, posBuf);
      gl!.enableVertexAttribArray(aPos);
      gl!.vertexAttribPointer(aPos, 3, gl!.FLOAT, false, 0, 0);
      gl!.bindBuffer(gl!.ARRAY_BUFFER, normBuf);
      gl!.enableVertexAttribArray(aNormal);
      gl!.vertexAttribPointer(aNormal, 3, gl!.FLOAT, false, 0, 0);
      gl!.uniform3fv(uColor, color);
    }

    // sketch mode: the face being sketched on stays lit (less dimmed)
    if (sk) {
      const f = faceByIndex.get(sk.face);
      if (f) {
        gl!.uniform1f(uDim, dimK * 0.3);
        gl!.drawArrays(gl!.TRIANGLES, f.start, f.count);
        gl!.uniform1f(uDim, dimK);
      }
    }

    // selected faces: re-draw their triangles in a tint (depthFunc LEQUAL lets
    // the identical geometry pass)
    if (selected.length && !sk && !showCand) {
      gl!.uniform3fv(uColor, SELECT);
      for (const idx of selected) {
        const f = faceByIndex.get(idx);
        if (f && f !== df) gl!.drawArrays(gl!.TRIANGLES, f.start, f.count);
      }
    }
    if (hovered !== null && !sk && !showCand) {
      const f = faceByIndex.get(hovered);
      gl!.uniform3fv(uColor, HOVER);
      if (f) gl!.drawArrays(gl!.TRIANGLES, f.start, f.count);
    }
    // the face a click would pick: a light tint over it
    const hf = hoverPick && 'face' in hoverPick && !sk && !showCand && !drag ? faceByIndex.get(hoverPick.face) : undefined;
    if (hf && hf.index !== hovered) {
      gl!.enable(gl!.BLEND);
      gl!.blendFuncSeparate(gl!.SRC_ALPHA, gl!.ONE_MINUS_SRC_ALPHA, gl!.ZERO, gl!.ONE);  // keep canvas alpha
      gl!.uniform3fv(uColor, HOVER);
      gl!.uniform1f(uAlpha, 0.35);
      gl!.drawArrays(gl!.TRIANGLES, hf.start, hf.count);
      gl!.uniform1f(uAlpha, 1);
      gl!.disable(gl!.BLEND);
    }

    if (df && drag) {
      // the face whose plane the drag snapped to
      const sf = drag.snap !== null ? faceByIndex.get(drag.snap) : undefined;
      if (sf) {
        gl!.uniform3fv(uColor, SNAP);
        gl!.drawArrays(gl!.TRIANGLES, sf.start, sf.count);
      }
      // the dragged face at its new place: its own triangles + motion*t, with
      // its own normals. Opaque where visible, then a faint x-ray pass so it
      // still shows when moved into the solid.
      const pos = new Float32Array(df.count * 3);
      for (let i = 0; i < pos.length; i++) pos[i] = meshPositions[df.start * 3 + i]! + drag.motion[i]! * drag.t;
      gl!.bindBuffer(gl!.ARRAY_BUFFER, previewBuf);
      gl!.bufferData(gl!.ARRAY_BUFFER, pos, gl!.DYNAMIC_DRAW);
      gl!.vertexAttribPointer(aPos, 3, gl!.FLOAT, false, 0, 0);
      gl!.bindBuffer(gl!.ARRAY_BUFFER, normBuf);
      gl!.vertexAttribPointer(aNormal, 3, gl!.FLOAT, false, 0, df.start * 12);
      gl!.uniform3fv(uColor, SELECT);
      gl!.drawArrays(gl!.TRIANGLES, 0, df.count);
      gl!.disable(gl!.DEPTH_TEST);
      gl!.enable(gl!.BLEND);
      gl!.blendFuncSeparate(gl!.SRC_ALPHA, gl!.ONE_MINUS_SRC_ALPHA, gl!.ZERO, gl!.ONE);  // keep canvas alpha
      gl!.uniform1f(uAlpha, 0.35);
      gl!.drawArrays(gl!.TRIANGLES, 0, df.count);
      gl!.uniform1f(uAlpha, 1);
      gl!.disable(gl!.BLEND);
      gl!.enable(gl!.DEPTH_TEST);
    }

    // coordinate frame + highlight all use the line program / same matrices
    gl!.useProgram(lineProg);
    gl!.uniformMatrix4fv(lProj, false, proj);
    gl!.uniformMatrix4fv(lView, false, view);
    gl!.uniformMatrix4fv(lModel, false, model);
    gl!.enableVertexAttribArray(lPos);
    const drawLines = (buf: WebGLBuffer, count: number, col: [number, number, number],
                       first = 0, n = count) => {
      gl!.uniform3fv(lColor, col);
      gl!.bindBuffer(gl!.ARRAY_BUFFER, buf);
      gl!.vertexAttribPointer(lPos, 3, gl!.FLOAT, false, 0, 0);
      gl!.drawArrays(gl!.LINES, first, n);
    };

    // ground grid on the Z=0 plane (orientation is shown by the corner gizmo)
    setSec(lSec, lSecOn, false);
    if (!thumbMode && !sk) {
      gl!.lineWidth(1);
      drawLines(gridBuf, gridCount, [0.45, 0.48, 0.53]);
    }
    // the section plane: its rectangle, faint (outline only)
    if (sec) {
      const r = planeRect(sec);
      const lines = new Float32Array([...r[0]!, ...r[1]!, ...r[1]!, ...r[3]!, ...r[3]!, ...r[2]!, ...r[2]!, ...r[0]!]);
      gl!.bindBuffer(gl!.ARRAY_BUFFER, planeBuf);
      gl!.bufferData(gl!.ARRAY_BUFFER, lines, gl!.DYNAMIC_DRAW);
      drawLines(planeBuf, 8, PLANE_LINE);
    }

    // construction planes: a translucent fill (not writing depth, so the part
    // behind still shows and picks), then the outline, faint where the part
    // hides it; selected in the selection colour, hovered brighter
    if (planes.length && !thumbMode && !sk) {
      const geo = planeGeometry();
      const pv = multiply(proj, multiply(view, model));
      const hp = hoverPlaneExt ?? (hoverPick && 'plane' in hoverPick && !drag ? hoverPick.plane : null);
      const colOf = (g: typeof geo[number]) =>
        (g.preview ? CPLANE_PREVIEW : selPlanes.includes(g.name) ? SELECT : g.name === hp ? CPLANE_HOVER : CPLANE);
      gl!.useProgram(fillProg);
      gl!.uniformMatrix4fv(fPV, false, pv);
      gl!.bindBuffer(gl!.ARRAY_BUFFER, planeFillBuf);
      gl!.enableVertexAttribArray(fPos);
      gl!.vertexAttribPointer(fPos, 3, gl!.FLOAT, false, 0, 0);
      gl!.enable(gl!.BLEND);
      gl!.blendFuncSeparate(gl!.SRC_ALPHA, gl!.ONE_MINUS_SRC_ALPHA, gl!.ZERO, gl!.ONE);  // keep canvas alpha
      gl!.depthMask(false);
      geo.forEach((g, i) => {
        gl!.uniform3fv(fColor, colOf(g));
        gl!.uniform1f(fAlpha, g.preview || selPlanes.includes(g.name) || g.name === hp ? 0.2 : 0.11);
        gl!.drawArrays(gl!.TRIANGLE_STRIP, i * 4, 4);
      });
      gl!.depthMask(true);
      gl!.disable(gl!.BLEND);
      gl!.useProgram(thickProg);
      gl!.uniformMatrix4fv(tPV, false, pv);
      gl!.uniform2f(tHalfPx, w / 2, h / 2);
      gl!.uniform1f(tBias, 3e-5);
      setSec(tSec, tSecOn, false);
      gl!.bindBuffer(gl!.ARRAY_BUFFER, planeEdgeBuf);
      gl!.enableVertexAttribArray(tPos);
      gl!.enableVertexAttribArray(tOther);
      gl!.enableVertexAttribArray(tSide);
      gl!.vertexAttribPointer(tPos, 3, gl!.FLOAT, false, 28, 0);
      gl!.vertexAttribPointer(tOther, 3, gl!.FLOAT, false, 28, 12);
      gl!.vertexAttribPointer(tSide, 1, gl!.FLOAT, false, 28, 24);
      for (const depth of [false, true]) {
        if (depth) gl!.enable(gl!.DEPTH_TEST); else gl!.disable(gl!.DEPTH_TEST);
        geo.forEach((g, i) => {
          const col = colOf(g);
          const strong = g.preview || selPlanes.includes(g.name) || g.name === hp;
          gl!.uniform3fv(tColor, depth ? col : col.map((c) => c * 0.55) as Vec3);
          gl!.uniform1f(tWidth, (strong ? 2.6 : 1.4) * dpr);
          gl!.drawArrays(gl!.TRIANGLES, i * 24, 24);
        });
      }
      gl!.enable(gl!.DEPTH_TEST);
      gl!.disableVertexAttribArray(tOther);
      gl!.disableVertexAttribArray(tSide);
      gl!.useProgram(lineProg);
      gl!.enableVertexAttribArray(lPos);
    }

    // highlight pass: bright, drawn over the solid (depth off so it's visible)
    setSec(lSec, lSecOn, true);
    if (lineVertexCount && !thumbMode && !sk) {
      gl!.disable(gl!.DEPTH_TEST);
      gl!.lineWidth(2);
      drawLines(lineBuf, lineVertexCount, HIGHLIGHT);
      gl!.enable(gl!.DEPTH_TEST);
    }

    // the sketches drawn on faces (while sketching, the sketcher draws them)
    if (sketchRanges.length && !thumbMode && (!sketch || sketch.phase === 'exit')) {
      gl!.useProgram(thickProg);
      gl!.uniformMatrix4fv(tPV, false, multiply(proj, multiply(view, model)));
      gl!.uniform2f(tHalfPx, w / 2, h / 2);
      gl!.uniform1f(tWidth, 1.6 * dpr);
      gl!.uniform1f(tBias, 3e-5);   // a few depth-buffer steps
      setSec(tSec, tSecOn, true);
      gl!.bindBuffer(gl!.ARRAY_BUFFER, sketchBuf);
      gl!.enableVertexAttribArray(tPos);
      gl!.enableVertexAttribArray(tOther);
      gl!.enableVertexAttribArray(tSide);
      gl!.vertexAttribPointer(tPos, 3, gl!.FLOAT, false, 28, 0);
      gl!.vertexAttribPointer(tOther, 3, gl!.FLOAT, false, 28, 12);
      gl!.vertexAttribPointer(tSide, 1, gl!.FLOAT, false, 28, 24);
      for (const r of sketchRanges) {
        gl!.uniform3fv(tColor, r.id === hoverSketch ? SKETCH_HOVER : SKETCH_LINE);
        gl!.drawArrays(gl!.TRIANGLES, r.first, r.count);
      }
      gl!.disableVertexAttribArray(tOther);
      gl!.disableVertexAttribArray(tSide);
    }

    // a dialog's marks: dim through the part, full where seen
    if (markRanges.length && !thumbMode && !sk) {
      gl!.useProgram(thickProg);
      gl!.uniformMatrix4fv(tPV, false, multiply(proj, multiply(view, model)));
      gl!.uniform2f(tHalfPx, w / 2, h / 2);
      gl!.uniform1f(tBias, 6e-5);
      setSec(tSec, tSecOn, true);
      gl!.bindBuffer(gl!.ARRAY_BUFFER, markBuf);
      gl!.enableVertexAttribArray(tPos);
      gl!.enableVertexAttribArray(tOther);
      gl!.enableVertexAttribArray(tSide);
      gl!.vertexAttribPointer(tPos, 3, gl!.FLOAT, false, 28, 0);
      gl!.vertexAttribPointer(tOther, 3, gl!.FLOAT, false, 28, 12);
      gl!.vertexAttribPointer(tSide, 1, gl!.FLOAT, false, 28, 24);
      for (const pass of [0, 1]) {
        if (pass === 0) gl!.disable(gl!.DEPTH_TEST);
        for (const r of markRanges) {
          gl!.uniform1f(tWidth, r.width * dpr);
          gl!.uniform3fv(tColor, pass === 0 ? r.color.map((c) => c * 0.45) as Vec3 : r.color);
          gl!.drawArrays(gl!.TRIANGLES, r.first, r.count);
        }
        if (pass === 0) gl!.enable(gl!.DEPTH_TEST);
      }
      gl!.disableVertexAttribArray(tOther);
      gl!.disableVertexAttribArray(tSide);
      gl!.useProgram(lineProg);
      gl!.enableVertexAttribArray(lPos);
    }

    // selected edges: thick, dimmer through the part where it hides them, in
    // full where seen; the hovered one (what a click would pick) on top
    const hoverE = hoverEdgeExt ?? (hoverPick && 'edge' in hoverPick && !drag ? hoverPick.edge : null);
    if ((selEdges.length || hoverE !== null) && !thumbMode && !sk) {
      gl!.useProgram(thickProg);
      gl!.uniformMatrix4fv(tPV, false, multiply(proj, multiply(view, model)));
      gl!.uniform2f(tHalfPx, w / 2, h / 2);
      gl!.uniform1f(tBias, 6e-5);
      setSec(tSec, tSecOn, true);
      gl!.bindBuffer(gl!.ARRAY_BUFFER, edgeBuf);
      gl!.enableVertexAttribArray(tPos);
      gl!.enableVertexAttribArray(tOther);
      gl!.enableVertexAttribArray(tSide);
      gl!.vertexAttribPointer(tPos, 3, gl!.FLOAT, false, 28, 0);
      gl!.vertexAttribPointer(tOther, 3, gl!.FLOAT, false, 28, 12);
      gl!.vertexAttribPointer(tSide, 1, gl!.FLOAT, false, 28, 24);
      const drawEdge = (i: number) => {
        const r = edgeRanges.get(i);
        if (r) gl!.drawArrays(gl!.TRIANGLES, r.first, r.count);
      };
      gl!.uniform1f(tWidth, 3 * dpr);
      gl!.disable(gl!.DEPTH_TEST);
      gl!.uniform3fv(tColor, SELECT.map((c) => c * 0.5) as Vec3);
      selEdges.forEach(drawEdge);
      gl!.enable(gl!.DEPTH_TEST);
      gl!.uniform3fv(tColor, SELECT);
      selEdges.forEach(drawEdge);
      if (hoverE !== null) {
        gl!.disable(gl!.DEPTH_TEST);
        gl!.uniform1f(tWidth, 4 * dpr);
        gl!.uniform3fv(tColor, HOVER);
        drawEdge(hoverE);
        gl!.enable(gl!.DEPTH_TEST);
      }
      gl!.disableVertexAttribArray(tOther);
      gl!.disableVertexAttribArray(tSide);
    }

    // the extrude preview: faint through the part, bright where it's in front
    if (ghost && sk && !thumbMode) {
      gl!.useProgram(thickProg);
      gl!.uniformMatrix4fv(tPV, false, multiply(proj, multiply(view, model)));
      gl!.uniform2f(tHalfPx, w / 2, h / 2);
      gl!.uniform1f(tBias, 3e-5);
      setSec(tSec, tSecOn, false);
      gl!.bindBuffer(gl!.ARRAY_BUFFER, ghostBuf);
      gl!.enableVertexAttribArray(tPos);
      gl!.enableVertexAttribArray(tOther);
      gl!.enableVertexAttribArray(tSide);
      gl!.vertexAttribPointer(tPos, 3, gl!.FLOAT, false, 28, 0);
      gl!.vertexAttribPointer(tOther, 3, gl!.FLOAT, false, 28, 12);
      gl!.vertexAttribPointer(tSide, 1, gl!.FLOAT, false, 28, 24);
      const g = ghost;
      const faint = g.color.map((c, i) => c * 0.45 + sk.bg[i]! * 0.55) as Vec3;
      for (const [depth, col] of [[false, faint], [true, g.color]] as [boolean, Vec3][]) {
        if (depth) gl!.enable(gl!.DEPTH_TEST); else gl!.disable(gl!.DEPTH_TEST);
        gl!.uniform3fv(tColor, col);
        gl!.uniform1f(tWidth, 1.6 * dpr);
        gl!.drawArrays(gl!.TRIANGLES, 0, g.edges);
        gl!.uniform1f(tWidth, 2.6 * dpr);
        gl!.drawArrays(gl!.TRIANGLES, g.edges, g.arrows);
      }
      gl!.enable(gl!.DEPTH_TEST);
      gl!.disableVertexAttribArray(tOther);
      gl!.disableVertexAttribArray(tSide);
    }

    // the section's outline: crisp, on the cap; then what is measured on it
    let placedMeasure: SectionMeasure | null = null;
    if (sec) {
      const cut = showCand ? candCut : partCut;
      const o = cutOutline(cut, sec);
      if (outlineFrom !== cut || !cut.uploaded) {
        gl!.bindBuffer(gl!.ARRAY_BUFFER, outlineBuf);
        gl!.bufferData(gl!.ARRAY_BUFFER, thickVerts(o.pts), gl!.DYNAMIC_DRAW);
        outlineFrom = cut; cut.uploaded = true;
      }
      gl!.useProgram(thickProg);
      gl!.uniformMatrix4fv(tPV, false, multiply(proj, multiply(view, model)));
      gl!.uniform2f(tHalfPx, w / 2, h / 2);
      setSec(tSec, tSecOn, false);
      gl!.enableVertexAttribArray(tPos);
      gl!.enableVertexAttribArray(tOther);
      gl!.enableVertexAttribArray(tSide);
      const bindThick = (buf: WebGLBuffer) => {
        gl!.bindBuffer(gl!.ARRAY_BUFFER, buf);
        gl!.vertexAttribPointer(tPos, 3, gl!.FLOAT, false, 28, 0);
        gl!.vertexAttribPointer(tOther, 3, gl!.FLOAT, false, 28, 12);
        gl!.vertexAttribPointer(tSide, 1, gl!.FLOAT, false, 28, 24);
      };
      if (o.count) {
        bindThick(outlineBuf);
        gl!.uniform1f(tBias, 6e-5);
        gl!.uniform1f(tWidth, 1.5 * dpr);
        gl!.uniform3fv(tColor, OUTLINE);
        gl!.drawArrays(gl!.TRIANGLES, 0, o.count * 6);
      }
      // measure lines: across the wall under the pointer (ticks at its ends),
      // the clicked points (small crosses) and the line between two
      const toCss = cssProjector();
      const mid = (a: Vec3, b: Vec3) => { const [x, y] = toCss(scale(add(a, b), 0.5)); return { x, y }; };
      const segs: number[] = [];
      const ppm = pxPerMm(planePoint(sec, modelCenter), o);
      const n = cutNormal(sec);
      const tick = (p: Vec3, along: Vec3, px: number) => {
        const l = Math.hypot(...along) || 1;
        const t = scale(along, px / ppm / l);
        segs.push(...add(p, t), ...add(p, scale(t, -1)));
      };
      let wall: SectionMeasure['wall'] = null, dist: SectionMeasure['distance'] = null;
      if (secHover && !showCand) {
        const { a, b } = secHover;
        const m: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const side: Vec3 = [n[1] * m[2] - n[2] * m[1], n[2] * m[0] - n[0] * m[2], n[0] * m[1] - n[1] * m[0]];
        segs.push(...a, ...b);
        tick(a, side, 5); tick(b, side, 5);
        wall = { mm: secHover.mm, approx: secHover.approx, ...mid(a, b) };
      }
      if (!showCand) {
        const [bu, bv] = o.basis;
        for (const pt of secPts) { tick(pt.p, add(bu, bv), 5); tick(pt.p, add(bu, scale(bv, -1)), 5); }
        if (secPts.length === 2) {
          const [a, b] = [secPts[0]!.p, secPts[1]!.p];
          segs.push(...a, ...b);
          dist = { mm: Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]),
                   approx: secPts[0]!.approx || secPts[1]!.approx, ...mid(a, b) };
        }
      }
      if (segs.length) {
        gl!.bindBuffer(gl!.ARRAY_BUFFER, measBuf);
        gl!.bufferData(gl!.ARRAY_BUFFER, thickVerts(segs), gl!.DYNAMIC_DRAW);
        bindThick(measBuf);
        gl!.disable(gl!.DEPTH_TEST);
        gl!.uniform1f(tWidth, 2 * dpr);
        gl!.uniform3fv(tColor, HOVER);
        gl!.drawArrays(gl!.TRIANGLES, 0, segs.length);
        gl!.enable(gl!.DEPTH_TEST);
      }
      gl!.disableVertexAttribArray(tOther);
      gl!.disableVertexAttribArray(tSide);
      placedMeasure = { wall, points: showCand ? 0 : secPts.length, distance: dist };
    }

    // report the view-space direction of each world axis (columns of the
    // rotation) so the UI can draw an orientation gizmo
    if (opts.onAxes && !thumbMode) {
      opts.onAxes([
        { name: 'X', x: rot[0]!, y: rot[1]!, z: rot[2]!, color: '#d95555' },
        { name: 'Y', x: rot[4]!, y: rot[5]!, z: rot[6]!, color: '#5fb36a' },
        { name: 'Z', x: rot[8]!, y: rot[9]!, z: rot[10]!, color: '#6a8cd9' },
      ]);
    }

    // project the dimension overlay to screen space (CSS px) for the HTML layer
    if (opts.onDims && !thumbMode) {
      const toCss = cssProjector();
      const arm = modelRadius * 0.12;
      opts.onDims(dims.map((d) => {
        const [x, y, vis] = toCss(d.point);
        let ax = x, ay = y;
        if (d.dir) [ax, ay] = toCss(add(d.point, scale(d.dir, arm)));
        return { key: d.key, label: d.label, x, y, ax, ay, visible: vis && !(sec && cutDepth(sec, d.point) > 1e-3) };
      }));
    }
    if (opts.onMarks && !thumbMode) {
      const toCss = cssProjector();
      opts.onMarks(sk ? [] : markPoints.map((d) => {
        const [x, y, vis] = toCss(d.point);
        return { key: d.key, label: d.label, x, y, ax: x, ay: y, visible: vis && !(sec && cutDepth(sec, d.point) > 1e-3) };
      }));
    }
    if (opts.onHandle && !thumbMode) opts.onHandle(placeHandle(cssProjector()));
    if (!thumbMode) {
      opts.onSectionHandle?.(placeSecHandle(cssProjector()));
      opts.onSectionMeasure?.(placedMeasure);
      if (opts.onPlaneLabels) {
        const toCss = cssProjector();
        opts.onPlaneLabels(sk ? [] : planeGeometry().map((g) => {
          const [x, y, vis] = toCss(labelCorner(g.corners));
          return { name: g.name, x, y, visible: vis, preview: g.preview };
        }));
      }
    }
  }

  const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  // advance the sketch-mode transition: pose, lens shift, dim and clip
  function stepCamAnim() {
    const a = camAnim!;
    const k = Math.min(1, (performance.now() - a.t0) / SKETCH_MS);
    const e = easeInOutCubic(k);
    const lerp = (x: number, y: number) => x + (y - x) * e;
    q = slerp(a.from.q, a.to.q, e);
    center = [0, 1, 2].map((i) => lerp(a.from.center[i]!, a.to.center[i]!)) as Vec3;
    distance = Math.exp(lerp(Math.log(a.from.distance), Math.log(a.to.distance)));
    lens = [lerp(a.from.lens[0], a.to.lens[0]), lerp(a.from.lens[1], a.to.lens[1])];
    dimK = lerp(a.dim[0], a.dim[1]);
    // the cut sweeps in from (or out to) beyond the part
    clipD = lerp(a.clip[0], a.clip[1]);
    if (k < 1) { scheduleRender(); return; }
    camAnim = null;
    if (sketch?.phase === 'enter') sketch.phase = 'on';
    else if (sketch?.phase === 'exit') {
      orthographic = saved?.orthographic ?? orthographic;
      sketch = null; saved = null; dimK = 0; clipD = Infinity;
    }
  }

  // the canvas just moved/resized (for sketch mode or back): the lens shift and
  // distance factor that keep the picture where it was on screen
  function holdPicture(): { lens: [number, number]; k: number } {
    const prev = lastRect, cur = canvas.getBoundingClientRect();
    if (!prev || !prev.height || !cur.width || !cur.height) return { lens: [0, 0], k: 1 };
    const dx = prev.left + prev.width / 2 - (cur.left + cur.width / 2);
    const dy = prev.top + prev.height / 2 - (cur.top + cur.height / 2);
    return { lens: [(2 * dx) / cur.width, (-2 * dy) / cur.height], k: cur.height / prev.height };
  }

  function renderNow() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    render();
  }

  // a drawn sketch under the pointer (CSS px in the canvas), within a few px
  function sketchAt(px: number, py: number): SketchLines | null {
    if (!sketchLines.length) return null;
    const toCss = cssProjector();
    const sec = activeSection();
    let best: SketchLines | null = null, bestD = 6;
    for (const s of sketchLines) {
      const g = s.segments;
      for (let i = 0; i + 5 < g.length; i += 6) {
        const a: Vec3 = [g[i]!, g[i + 1]!, g[i + 2]!], b: Vec3 = [g[i + 3]!, g[i + 4]!, g[i + 5]!];
        if (sec && (cutDepth(sec, a) > 1e-4 || cutDepth(sec, b) > 1e-4)) continue;   // cut away
        const [ax, ay, va] = toCss(a);
        const [bx, by, vb] = toCss(b);
        if (!va || !vb) continue;
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
        const u = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
        const d = Math.hypot(px - (ax + u * dx), py - (ay + u * dy));
        if (d < bestD) { bestD = d; best = s; }
      }
    }
    return best;
  }

  // ── interaction ──
  // a gesture is an orbit (or a click → pick) or a handle drag, fixed at
  // pointer-down; a handle drag never orbits
  let mode: 'none' | 'orbit' | 'handle' | 'section' = 'none';
  let lastX = 0, lastY = 0;
  let downX = 0, downY = 0, moved = 0;
  const baseCursor = canvas.style.cursor;

  function overHandle(e: PointerEvent, h = placeHandle(cssProjector())): boolean {
    if (!h || !h.visible) return false;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    // distance to the arrow segment (anchor → tip), with a little slop
    const dx = h.ax - h.x, dy = h.ay - h.y, l2 = dx * dx + dy * dy;
    const u = l2 > 0 ? Math.max(0, Math.min(1, ((px - h.x) * dx + (py - h.y) * dy) / l2)) : 0;
    return Math.hypot(px - (h.x + u * dx), py - (h.y + u * dy)) <= 9;
  }

  // new param value for the pointer position: the mouse delta projected onto
  // the shift's screen direction, snapped to a 0.5 grid (Shift: 0.1) — or onto
  // another face's plane when one is within a few px
  function dragTo(e: PointerEvent) {
    const base = handleBase();
    if (!drag || !handle || !base) return;
    const f = handle.at ? undefined : faceByIndex.get(handle.face);
    const toCss = cssProjector();
    if (handle.turn) { turnTo(e, base, handle.turn, toCss); return; }
    const [x0, y0] = toCss(base);
    const [x1, y1] = toCss(add(base, dragShift(handle.shift, handle.dr)));
    const sx = x1 - x0, sy = y1 - y0;
    const mx = e.clientX - drag.x0, my = e.clientY - drag.y0;
    const t = dragAmount([mx, my], [sx, sy]);
    if (t === null) return;
    let value = handle.value, snap: number | null = null;
    if (Math.hypot(mx, my) >= 3) {   // dead zone: a press alone doesn't jump to the grid
      value = snapToStep(handle.value + t, handle.step ?? (e.shiftKey ? 0.1 : 0.5));
      // a radius stays a radius: no smaller than one step
      const min = handle.min ?? (handle.dr && handle.value > 0 ? (handle.step ?? (e.shiftKey ? 0.1 : 0.5)) : null);
      if (min != null) value = Math.max(min, value);
      const from = handle.at && handle.snapFaces
        ? { index: -1, start: 0, count: 0, kind: 'plane', area: 0, center: add(base, scale(handle.shift, handle.value)),
            normal: handle.shift } : f;
      const hit = from && snapToPlane(from, handle.shift, t, Math.hypot(sx, sy), faces, handle.moves);
      if (hit) { value = snapToStep(handle.value + hit.t, 0.001); snap = hit.face; }
    }
    const was = drag.value;
    drag.value = value;
    drag.t = value - handle.value;
    drag.snap = snap;
    if (handle.at && value !== was) opts.onHandleMove?.(value, false);
    scheduleRender();
  }

  // a rotation handle: the pointer's turn about the axis since pointer-down
  // (seen square-on where the view allows, else along the knob's way round),
  // snapped to 1° (Shift 0.1°), kept within ±180°
  function turnTo(e: PointerEvent, at: Vec3, turn: NonNullable<DragHandle["turn"]>,
                  toCss: (p: Vec3) => [number, number, boolean]) {
    if (!drag || !handle) return;
    const rect = canvas.getBoundingClientRect();
    const arm = Math.max(handleArm(), turn.arm ?? 0);
    const [cx, cy] = toCss(at);
    const [wx, wy] = toCss(add(at, scale(turn.w, arm)));
    const [nx, ny] = toCss(add(at, scale(turn.n, arm)));
    const sw = [wx - cx, wy - cy], sn = [nx - cx, ny - cy];
    const det = sw[0]! * sn[1]! - sw[1]! * sn[0]!;
    const mx = e.clientX - drag.x0, my = e.clientY - drag.y0;
    let da: number | null;
    if (Math.abs(det) > 0.2 * Math.hypot(sw[0]!, sw[1]!) * Math.hypot(sn[0]!, sn[1]!)) {
      const ang = (px: number, py: number) => {
        const qx = px - rect.left - cx, qy = py - rect.top - cy;
        const a = (qx * sn[1]! - qy * sn[0]!) / det, b = (sw[0]! * qy - sw[1]! * qx) / det;
        return Math.atan2(b, a);
      };
      da = ang(e.clientX, e.clientY) - ang(drag.x0, drag.y0);
      if (da > Math.PI) da -= 2 * Math.PI;
      if (da < -Math.PI) da += 2 * Math.PI;
    } else {
      const r = (handle.value * Math.PI) / 180;
      const tan = add(scale(turn.w, -arm * Math.sin(r)), scale(turn.n, arm * Math.cos(r)));
      const k = add(at, add(scale(turn.w, arm * Math.cos(r)), scale(turn.n, arm * Math.sin(r))));
      const [k0x, k0y] = toCss(k), [k1x, k1y] = toCss(add(k, tan));
      da = dragAmount([mx, my], [k1x - k0x, k1y - k0y]);
    }
    if (da === null) return;
    let value = handle.value;
    if (Math.hypot(mx, my) >= 3) {
      const raw = handle.value + (da * 180) / Math.PI;
      value = snapToStep(raw, handle.step ?? (e.shiftKey ? turn.fine ?? 0.1 : turn.step ?? 1));
      if (turn.stick && Math.abs(raw - Math.round(raw / turn.stick) * turn.stick) < 2) value = Math.round(raw / turn.stick) * turn.stick;
      value = ((value + 180) % 360 + 360) % 360 - 180;
      if (value === -180) value = 180;
    }
    const was = drag.value;
    drag.value = value;
    drag.t = value - handle.value;
    drag.snap = null;
    if (value !== was) opts.onHandleMove?.(value, false);
    scheduleRender();
  }

  // the section plane dragged along its dir, snapped like a handle: to a 0.5
  // grid (Shift 0.1), or onto a parallel flat face within a few px
  function secDragTo(e: PointerEvent) {
    const s = section;
    if (!secDrag || !s) return;
    const base = add(planePoint(s, modelCenter), scale(s.dir, secDrag.offset0 - s.offset));
    const toCss = cssProjector();
    const [x0, y0] = toCss(base);
    const [x1, y1] = toCss(add(base, s.dir));
    const sx = x1 - x0, sy = y1 - y0;
    const mx = e.clientX - secDrag.x0, my = e.clientY - secDrag.y0;
    const t = dragAmount([mx, my], [sx, sy]);
    if (t === null) return;
    let offset = secDrag.offset0, snap: number | null = null;
    if (Math.hypot(mx, my) >= 3) {
      offset = snapToStep(secDrag.offset0 + t, e.shiftKey ? 0.1 : 0.5);
      const plane = { index: -1, start: 0, count: 0, kind: 'plane', center: base, normal: s.dir };
      const hit = snapToPlane(plane, s.dir, t, Math.hypot(sx, sy), faces, []);
      if (hit) { offset = secDrag.offset0 + hit.t; snap = hit.face; }
    }
    if (offset === s.offset && snap === secDrag.snap) return;
    section = { ...s, offset };
    secDrag.snap = snap;
    secHover = null; secPts = [];
    opts.onSection?.(section, { dragging: true, snapFace: snap });
    scheduleRender();
  }
  function endSecDrag(cancel: boolean) {
    window.removeEventListener('keydown', onKey);
    canvas.style.cursor = baseCursor;
    if (!secDrag) return;
    if (cancel && section) section = { ...section, offset: secDrag.offset0 };
    secDrag = null;
    if (section) opts.onSection?.(section, { dragging: false, snapFace: null });
    scheduleRender();
  }

  function endHandleDrag(cancel: boolean) {
    window.removeEventListener('keydown', onKey);
    canvas.style.cursor = baseCursor;
    if (!drag || !handle) return;
    if (handle.at) {
      // a point handle: nothing to keep up until a rebuild; it stays at the new value
      const v = drag.value;
      drag = null;
      if (cancel || v === handle.value) opts.onHandleMove?.(handle.value, true);
      else { handle = { ...handle, value: v }; opts.onHandleDrop?.(v); }
    } else if (cancel || drag.value === handle.value) drag = null;
    else { drag.pending = true; opts.onHandleDrop?.(drag.value); }
    scheduleRender();
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && cancelDrag()) e.preventDefault();
  }
  function cancelDrag(): boolean {
    if (secDrag) { mode = 'none'; endSecDrag(true); return true; }
    if (drag && !drag.pending) { mode = 'none'; endHandleDrag(true); return true; }
    return false;
  }

  function onDown(e: PointerEvent) {
    if (sketch) return;   // sketch mode: the sketcher owns the view
    overhangHover(null);
    lastX = e.clientX; lastY = e.clientY;
    downX = e.clientX; downY = e.clientY; moved = 0;
    canvas.setPointerCapture(e.pointerId);
    const f = handle && !handle.at ? faceByIndex.get(handle.face) : undefined;
    if (e.button === 0 && handle && (f || handle.at) && !drag?.pending && overHandle(e)) {
      mode = 'handle';
      drag = { x0: e.clientX, y0: e.clientY, t: 0, value: handle.value, snap: null,
               motion: f ? faceMotion(f, meshPositions, handle.shift, handle.dr) : new Float32Array(0), pending: false };
      canvas.style.cursor = 'grabbing';
      window.addEventListener('keydown', onKey);
      scheduleRender();
      return;
    }
    const sec = activeSection();
    if (e.button === 0 && sec && !drag?.pending && overHandle(e, placeSecHandle(cssProjector()))) {
      mode = 'section';
      secDrag = { x0: e.clientX, y0: e.clientY, offset0: sec.offset, snap: null };
      secHover = null;
      canvas.style.cursor = 'grabbing';
      window.addEventListener('keydown', onKey);
      scheduleRender();
      return;
    }
    anim = null;   // grabbing the view stops a view animation where it is
    if (secHover) { secHover = null; scheduleRender(); }
    mode = 'orbit';
    hoverXY = null;
    setHoverPick(null);
  }
  function onMove(e: PointerEvent) {
    if (mode === 'handle') { if (drag && !drag.pending) dragTo(e); return; }
    if (mode === 'section') { secDragTo(e); return; }
    if (mode === 'none') {   // hover: show the handle is grabbable
      if (sketch) return;
      const onHandle = (handle && !drag?.pending && overHandle(e))
        || (activeSection() && overHandle(e, placeSecHandle(cssProjector())));
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      const s = onHandle ? null : sketchAt(px, py);
      if ((s?.id ?? null) !== hoverSketch) { hoverSketch = s?.id ?? null; scheduleRender(); }
      opts.onSketchHover?.(s ? { id: s.id, name: s.name, x: px, y: py } : null);
      if (onHandle || s) {
        setHoverPick(null); canvas.style.cursor = 'pointer';
        if (secHover) { secHover = null; scheduleRender(); }
      } else hoverLater(px, py);
      return;
    }
    moved += Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY);
    // Z-up turntable; vertical is unlimited, so rolling past the poles shows the bottom
    q = orbit(q, e.clientX - lastX, e.clientY - lastY);
    lastX = e.clientX; lastY = e.clientY;
    scheduleRender();
  }
  // the hover pick, worked out once a frame at the latest pointer position
  let hoverXY: [number, number] | null = null;
  let hoverRaf = 0;
  function hoverLater(px: number, py: number) {
    hoverXY = [px, py];
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      if (!hoverXY || mode !== 'none' || sketch) { overhangHover(null); return; }
      // on the section's cut: measure the wall there instead
      if (measureAt(hoverXY[0], hoverXY[1])) { setHoverPick(null); overhangHover(null); canvas.style.cursor = 'crosshair'; return; }
      overhangHover(ov && !cand ? hoverXY : null);
      const p = opts.onPick ? pickAt(hoverXY[0], hoverXY[1]) : null;
      setHoverPick(p && ('edge' in p ? { edge: p.edge } : 'plane' in p ? { plane: p.plane } : { face: p.face.index }));
      canvas.style.cursor = p && ('edge' in p || 'plane' in p) ? 'pointer' : baseCursor;
    });
  }
  // over a highlighted overhang: say its angle
  let ovHoverKey = '';
  function overhangHover(at: [number, number] | null) {
    const hit = at && ov ? hitAt(at[0], at[1]) : null;
    let r: { text: string; kind: OverhangKind; x: number; y: number } | null = null;
    if (hit?.tri != null && ov) {
      const v = hit.tri * 3, P = (i: number): Vec3 => [meshPositions[i * 3]!, meshPositions[i * 3 + 1]!, meshPositions[i * 3 + 2]!];
      const a = P(v), b = P(v + 1), c = P(v + 2);
      let n = cross(sub(b, a), sub(c, a));
      if (partBodies().some((e) => e.vol < 0 && e.ranges.some(([s0, k]) => v >= s0 && v < s0 + k))) n = scale(n, -1);
      const alpha = overhangAngle(n, ov.down);
      const kind = overhangKind(alpha, ov.threshold);
      if (kind && !onBed(n, [a, b, c], ov.down, ov.bed)) r = { text: overhangHoverText(alpha!, kind), kind, x: at![0], y: at![1] };
    }
    const key = r ? `${r.text}@${r.x},${r.y}` : '';
    if (key === ovHoverKey) return;
    ovHoverKey = key;
    opts.onOverhangHover?.(r);
  }
  function setHoverPick(p: { edge: number } | { face: number } | { plane: string } | null) {
    const key = (x: typeof p) => (x ? ('edge' in x ? `e${x.edge}` : 'plane' in x ? `p${x.plane}` : `f${x.face}`) : '');
    if (key(p) === key(hoverPick)) return;
    hoverPick = p;
    scheduleRender();
  }

  function onUp(e: PointerEvent) {
    const was = mode;
    mode = 'none';
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (was === 'handle') {
      if (drag && !drag.pending) endHandleDrag(false);
      return;
    }
    if (was === 'section') { endSecDrag(false); return; }
    if (was === 'orbit' && moved < 4) {
      // a click on the section's outline: a point to measure from (a third
      // starts again); anywhere else drops them
      const rect = canvas.getBoundingClientRect();
      const r = outlineAt(downX - rect.left, downY - rect.top, 8, false);
      if (r) {
        if (secPts.length >= 2) secPts = [];
        secPts.push({ p: fromPlane(r.o, r.s, r.near.p), approx: segApprox(r.o, r.near.seg) });
        scheduleRender();
        return;
      }
      if (secPts.length) { secPts = []; scheduleRender(); }
    }
    if (was === 'orbit' && moved < 4 && opts.onPick) {  // a click, not a drag → pick a face or an edge
      const rect = canvas.getBoundingClientRect();
      opts.onPick(pickAt(downX - rect.left, downY - rect.top), { shift: e.shiftKey, alt: e.altKey });  // caller sets selection
    }
  }
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    if (sketch) return;
    distance *= Math.exp(e.deltaY * 0.001);
    scheduleRender();
  }
  function onDblClick(e: MouseEvent) {
    if (sketch) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const s = opts.onSketchOpen ? sketchAt(px, py) : null;
    if (s) { opts.onSketchOpen!(s.id); return; }
    if (!opts.onEdgeDoubleClick || filter === 'faces') return;
    const p = pickAt(px, py);
    if (!p || !('edge' in p)) return;
    // the face it borders that the cursor is over, else the one facing the viewer
    const e0 = edges.find((x) => x.index === p.edge);
    const own = [...new Set(e0?.faceIndices ?? [])];
    const under = pick(px, py)?.index ?? null;
    let face: number | null = under !== null && own.includes(under) ? under : null;
    if (face === null && own.length) {
      const { toward } = ndcProjector();
      const at = e0!.polyline[Math.floor(e0!.polyline.length / 2)] ?? center;
      const v = toward(at);
      let best = -Infinity;
      for (const i of own) {
        const f = faceByIndex.get(i);
        const d = f ? dot3(f.normal, v) : -Infinity;
        if (d > best) { best = d; face = i; }
      }
    }
    opts.onEdgeDoubleClick({ edge: p.edge, face }, { shift: e.shiftKey, alt: e.altKey });
  }
  function onLeave() {
    if (hoverSketch) { hoverSketch = null; scheduleRender(); }
    if (secHover) { secHover = null; scheduleRender(); }
    opts.onSketchHover?.(null);
    hoverXY = null;
    setHoverPick(null);
    overhangHover(null);
  }
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('dblclick', onDblClick);
  canvas.addEventListener('pointerleave', onLeave);

  function animateTo(to: Quat) {
    anim = { from: q, to, t0: performance.now() };
    scheduleRender();
  }

  const ro = new ResizeObserver(() => scheduleRender());
  ro.observe(canvas);

  return {
    update(mesh: ViewerMesh, facesArg?: FaceRange[]) {
      uploadMesh(mesh);
      meshPositions = mesh.positions;
      faces = facesArg ?? [];
      faceByIndex = new Map(faces.map((f) => [f.index, f]));
      // the section stays; its outline and caps are the new mesh's
      partCut = newCut(mesh.positions, mesh.normals);
      capGroups = null;
      bodyList = null;
      triFace = new Int32Array(mesh.positions.length / 9).fill(-1);
      faces.forEach((f, i) => triFace.fill(i, f.start / 3, (f.start + f.count) / 3));
      if (ov) ov.bed = bedLevel(meshPositions, ov.down);
      secHover = null; secPts = [];
      if (secDrag) endSecDrag(true);
      selected = [];
      hovered = null;
      hoverPick = null;
      handle = null;
      if (drag) endHandleDrag(true);
      scheduleRender();
    },
    highlightEdges(segments: number[]) {
      gl!.bindBuffer(gl!.ARRAY_BUFFER, lineBuf);
      gl!.bufferData(gl!.ARRAY_BUFFER, new Float32Array(segments), gl!.DYNAMIC_DRAW);
      lineVertexCount = segments.length / 3;
      scheduleRender();
    },
    selectFaces(indices: number[]) { selected = indices; scheduleRender(); },
    setEdges(list: EdgeLike[]) {
      edges = list;
      const all: number[] = [];
      edgeRanges = new Map();
      for (const e of list) {
        const first = all.length;
        for (let i = 0; i + 1 < e.polyline.length; i++) all.push(...e.polyline[i]!, ...e.polyline[i + 1]!);
        // 6 floats a segment in, 6 vertices out
        if (all.length > first) edgeRanges.set(e.index, { first, count: all.length - first });
      }
      gl!.bindBuffer(gl!.ARRAY_BUFFER, edgeBuf);
      gl!.bufferData(gl!.ARRAY_BUFFER, thickVerts(all), gl!.STATIC_DRAW);
      capGroups = null;   // the bodies come from which faces the edges join
      bodyList = null;
      selEdges = [];
      hoverEdgeExt = null;
      hoverPick = null;
      scheduleRender();
    },
    selectEdges(indices: number[]) { selEdges = indices; scheduleRender(); },
    hoverEdge(index: number | null) {
      if (index === hoverEdgeExt) return;
      hoverEdgeExt = index;
      scheduleRender();
    },
    setPlanes(list: PlaneShape[]) {
      planes = list;
      planeGeoStale = true;
      if (hoverPick && 'plane' in hoverPick && !list.some((p) => p.name === (hoverPick as { plane: string }).plane)) hoverPick = null;
      scheduleRender();
    },
    selectPlanes(names: string[]) { selPlanes = names; scheduleRender(); },
    hoverPlane(name: string | null) {
      if (name === hoverPlaneExt) return;
      hoverPlaneExt = name;
      scheduleRender();
    },
    setPickFilter(f: PickFilter) {
      filter = f;
      hoverPick = null;
      scheduleRender();
    },
    setPreviewMesh(p) {
      if (!p) { cand = null; candExtra = null; candPositions = []; candCut = newCut([], []); scheduleRender(); return; }
      if (p.extra) {
        gl!.bindBuffer(gl!.ARRAY_BUFFER, extraPosBuf);
        gl!.bufferData(gl!.ARRAY_BUFFER, new Float32Array(p.extra.mesh.positions), gl!.STATIC_DRAW);
        gl!.bindBuffer(gl!.ARRAY_BUFFER, extraNormBuf);
        gl!.bufferData(gl!.ARRAY_BUFFER, new Float32Array(p.extra.mesh.normals), gl!.STATIC_DRAW);
        candExtra = { count: p.extra.mesh.positions.length / 3, color: p.extra.color };
      } else {
        candExtra = null;
      }
      gl!.bindBuffer(gl!.ARRAY_BUFFER, candPosBuf);
      gl!.bufferData(gl!.ARRAY_BUFFER, new Float32Array(p.mesh.positions), gl!.STATIC_DRAW);
      gl!.bindBuffer(gl!.ARRAY_BUFFER, candNormBuf);
      gl!.bufferData(gl!.ARRAY_BUFFER, new Float32Array(p.mesh.normals), gl!.STATIC_DRAW);
      const count = p.mesh.positions.length / 3;
      cand = { count, color: p.color, inverted: signedVolume6(p.mesh.positions, 0, count) < 0 };
      candPositions = p.mesh.positions;
      if (ov) ov.candBed = bedLevel(candPositions, ov.down);
      candCut = newCut(p.mesh.positions, p.mesh.normals);
      secHover = null;
      scheduleRender();
    },
    hoverFace(index: number | null) {
      if (index === hovered) return;
      hovered = index;
      scheduleRender();
    },
    setInset(px: number) {
      if (px === inset) return;
      inset = Math.max(0, px);
      scheduleRender();
    },
    setDims(d: DimAnchor[]) { dims = d; scheduleRender(); },
    setMarks(m) {
      const all: number[] = [];
      markRanges = [];
      for (const l of m?.lines ?? []) {
        if (l.segments.length < 6) continue;
        markRanges.push({ first: all.length, count: l.segments.length, color: l.color, width: l.width ?? 1.6 });
        for (const v of l.segments) all.push(v);
      }
      markPoints = m?.points ?? [];
      gl!.bindBuffer(gl!.ARRAY_BUFFER, markBuf);
      gl!.bufferData(gl!.ARRAY_BUFFER, thickVerts(all), gl!.DYNAMIC_DRAW);
      scheduleRender();
    },
    setSection(sArg: Section | null) {
      if (sArg === section) return;   // our own onSection, echoed back
      if (secDrag) { secDrag = null; mode = 'none'; window.removeEventListener('keydown', onKey); canvas.style.cursor = baseCursor; }
      section = sArg;
      secHover = null; secPts = [];
      hoverPick = null;
      if (!sArg) opts.onSectionMeasure?.(null);
      scheduleRender();
    },
    setOverhangs(o) {
      if (!o) { ov = null; overhangHover(null); scheduleRender(); return; }
      const l = Math.hypot(...o.down) || 1;
      const down: Vec3 = [o.down[0] / l, o.down[1] / l, o.down[2] / l];
      ov = { down, threshold: o.threshold, bed: bedLevel(meshPositions, down), candBed: bedLevel(candPositions, down) };
      ovHoverKey = '';
      // the threshold or bed changed under the pointer: say the angle there afresh
      overhangHover(hoverXY && mode === 'none' && !sketch && !cand ? hoverXY : null);
      scheduleRender();
    },
    invertedRanges() {
      return vertexCount ? partBodies().filter((b) => b.vol < 0).flatMap((b) => b.ranges) : [];
    },
    sectionFrame() {
      const rot = quatToMat4(anim ? anim.to : q);
      return { back: [rot[2]!, rot[6]!, rot[10]!] as Vec3, center: modelCenter };
    },
    clearSectionPoints() {
      if (secPts.length) { secPts = []; scheduleRender(); }
    },
    cancelDrag,
    setHandle(h: DragHandle | null) {
      if (drag) endHandleDrag(true);
      handle = h;
      scheduleRender();
    },
    clearDragPreview() {
      if (drag?.pending) { drag = null; scheduleRender(); }
    },
    capture(w = 240, h = 180): string {
      if (!vertexCount) return '';
      thumbMode = true;
      try { render(); } finally { thumbMode = false; }
      const off = document.createElement('canvas');
      off.width = w; off.height = h;
      const ctx = off.getContext('2d');
      if (!ctx) return '';
      ctx.drawImage(canvas, 0, 0, w, h);   // GL buffer preserved → part on transparent
      const url = off.toDataURL('image/png');
      scheduleRender();                    // restore the normal (grid + overlays) view
      return url;
    },
    setView(view: StandardView) { animateTo(lookFrom(VIEW_DIRS[view])); },
    lookAlong(normal: Vec3) {
      if (Math.hypot(...normal) > 1e-9) animateTo(lookFrom(normal));
    },
    viewAxis(axis: 'X' | 'Y' | 'Z') { animateTo(axisView(axis, anim ? anim.to : q)); },
    toggleOrtho() {
      orthographic = !orthographic;
      scheduleRender();
      return orthographic;
    },
    enterSketch(s) {
      const hold = holdPicture();
      const back = sketch?.phase === 'exit' && saved ? saved : null;   // re-entered mid-exit
      saved = back ?? { q: anim ? anim.to : q, center, distance, orthographic };
      anim = null;
      mode = 'none';
      if (drag) endHandleDrag(true);
      orthographic = true;
      sketch = { plane: s.plane, face: s.face, bg: s.bg, phase: 'enter' };
      hoverSketch = null;
      hoverPick = null;
      ghost = null; sketchPose = null;
      const far = modelRadius * 3;
      sketchClip = s.clip === false ? 1e9 : Math.max(0.02, modelRadius * 1e-3);
      camAnim = {
        from: { q, center, distance: distance * hold.k, lens: hold.lens },
        to: { q: planeQuat(s.plane), center: s.center, distance: s.halfH / TAN_HALF, lens: [0, 0] },
        t0: performance.now(),
        dim: [dimK, 1],
        clip: [Number.isFinite(clipD) ? clipD : far, sketchClip],
      };
      stepCamAnim();
      renderNow();
    },
    setSketchCamera(c, halfH) {
      if (!sketch || sketch.phase === 'exit') return;
      const d = halfH / TAN_HALF;
      if (ghost) { sketchPose = { center: c, distance: d }; return; }
      if (camAnim) { camAnim.to.center = c; camAnim.to.distance = d; renderNow(); return; }
      if (d === distance && c[0] === center[0] && c[1] === center[1] && c[2] === center[2] && !raf) return;
      center = c; distance = d;
      renderNow();
    },
    exitSketch() {
      if (!sketch || !saved || sketch.phase === 'exit') return;
      const hold = holdPicture();
      sketch.phase = 'exit';
      ghost = null; sketchPose = null;
      camAnim = {
        from: { q, center, distance: distance * hold.k, lens: hold.lens },
        to: { q: saved.q, center: saved.center, distance: saved.distance, lens: [0, 0] },
        t0: performance.now(),
        dim: [dimK, 0],
        clip: [clipD, modelRadius * 3],
      };
      stepCamAnim();
      renderNow();
    },
    setSketchLines(list) {
      sketchLines = list.filter((s) => s.segments.length >= 6);
      const all: number[] = [];
      sketchRanges = [];
      for (const s of sketchLines) {
        // a segment is 6 floats in and 6 vertices out, so float and vertex counts match
        sketchRanges.push({ id: s.id, first: all.length, count: s.segments.length });
        for (const v of s.segments) all.push(v);
      }
      gl!.bindBuffer(gl!.ARRAY_BUFFER, sketchBuf);
      gl!.bufferData(gl!.ARRAY_BUFFER, thickVerts(all), gl!.STATIC_DRAW);
      if (hoverSketch && !sketchLines.some((s) => s.id === hoverSketch)) hoverSketch = null;
      scheduleRender();
    },
    setExtrudePreview(p) {
      if (!sketch || sketch.phase === 'exit') return;
      const t0 = performance.now();
      if (!p) {
        if (!ghost) return;
        const back = sketchPose ?? { center, distance };
        ghost = null; sketchPose = null;
        camAnim = {
          from: { q, center, distance, lens },
          to: { q: planeQuat(sketch.plane), center: back.center, distance: back.distance, lens: [0, 0] },
          t0, dim: [dimK, 1], clip: [clipD, sketchClip],
        };
        stepCamAnim();
        renderNow();
        return;
      }
      gl!.bindBuffer(gl!.ARRAY_BUFFER, ghostBuf);
      gl!.bufferData(gl!.ARRAY_BUFFER, thickVerts([...p.edges, ...p.arrows]), gl!.DYNAMIC_DRAW);
      const first = !ghost;
      ghost = { edges: p.edges.length, arrows: p.arrows.length, color: p.color };
      if (first) {
        sketchPose = camAnim ? { center: camAnim.to.center, distance: camAnim.to.distance } : { center, distance };
        // frame the part and the preview together, seen from off the plane
        let lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
        const grow = (x: number, y: number, z: number) => {
          lo = [Math.min(lo[0], x), Math.min(lo[1], y), Math.min(lo[2], z)];
          hi = [Math.max(hi[0], x), Math.max(hi[1], y), Math.max(hi[2], z)];
        };
        if (vertexCount) {
          grow(modelCenter[0] - modelRadius, modelCenter[1] - modelRadius, modelCenter[2] - modelRadius);
          grow(modelCenter[0] + modelRadius, modelCenter[1] + modelRadius, modelCenter[2] + modelRadius);
        }
        for (let i = 0; i + 2 < p.edges.length; i += 3) grow(p.edges[i]!, p.edges[i + 1]!, p.edges[i + 2]!);
        const c: Vec3 = Number.isFinite(lo[0]) ? scale(add(lo, hi), 0.5) : center;
        const r = Number.isFinite(lo[0]) ? Math.max(Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2, 1) : modelRadius;
        const n = sketch.plane.normal, iso = VIEW_DIRS.iso;
        let w = add(iso, scale(n, -dot3(iso, n)));
        if (Math.hypot(...w) < 0.2) w = sketch.plane.xDir;
        w = scale(w, 1 / Math.hypot(...w));
        camAnim = {
          from: { q, center, distance, lens },
          to: { q: lookFrom(add(scale(n, 0.85), w)), center: c, distance: (r * 1.1) / TAN_HALF, lens: [0, 0] },
          t0, dim: [dimK, 0.3], clip: [clipD, modelRadius * 3],
        };
        stepCamAnim();
      }
      renderNow();
    },
    dispose() {
      if (raf) cancelAnimationFrame(raf);
      if (hoverRaf) cancelAnimationFrame(hoverRaf);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('dblclick', onDblClick);
      canvas.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('keydown', onKey);
      gl.deleteBuffer(posBuf);
      gl.deleteBuffer(previewBuf);
      gl.deleteBuffer(normBuf);
      gl.deleteBuffer(lineBuf);
      gl.deleteBuffer(gridBuf);
      gl.deleteBuffer(sketchBuf);
      gl.deleteBuffer(markBuf);
      gl.deleteBuffer(ghostBuf);
      gl.deleteBuffer(edgeBuf);
      gl.deleteBuffer(candPosBuf);
      gl.deleteBuffer(candNormBuf);
      gl.deleteBuffer(extraPosBuf);
      gl.deleteBuffer(extraNormBuf);
      gl.deleteBuffer(outlineBuf);
      gl.deleteBuffer(capBuf);
      gl.deleteBuffer(planeBuf);
      gl.deleteBuffer(planeFillBuf);
      gl.deleteBuffer(planeEdgeBuf);
      gl.deleteProgram(fillProg);
      gl.deleteBuffer(measBuf);
      gl.deleteProgram(prog);
      gl.deleteProgram(lineProg);
      gl.deleteProgram(thickProg);
      gl.deleteProgram(capProg);
    },
  };
}
