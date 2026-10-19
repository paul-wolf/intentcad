/**
 * Minimal dependency-free WebGL viewer for a static triangle-soup mesh
 * (flat positions + per-face normals, as returned by /api/build/).
 *
 * Deliberately not three.js — this only needs to draw one static solid with
 * orbit + zoom, perspective or orthographic. Column-major 4x4 math, two light directions for winding-
 * independent shading, render-on-demand.
 */

import { add, scale, faceMotion, dragAmount, snapToStep, snapToPlane, type Vec3 } from './dragHandle';
import {
  lookFrom, axisView, orbit, slerp, quatToMat4, easeInOutCubic, VIEW_DIRS,
  type Quat, type StandardView,
} from './viewOrient';
import { planeQuat, type PlaneBasis } from './sketchPlane';

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

const VERT = `
attribute vec3 aPos;
attribute vec3 aNormal;
uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uModel;
uniform mat3 uNormal;
varying vec3 vNormal;
varying vec3 vWorld;
void main() {
  vNormal = uNormal * aNormal;
  vWorld = aPos;
  gl_Position = uProj * uView * uModel * vec4(aPos, 1.0);
}`;

// uClip: discard what lies beyond the plane dot(p, xyz) = w (sketch mode
// cuts away the part between the camera and the sketch plane). uDim fades the
// colour toward a desaturated mix with the background uBg.
const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec3 vNormal;
varying vec3 vWorld;
uniform vec3 uColor;
uniform float uAlpha;
uniform vec4 uClip;
uniform float uDim;
uniform vec3 uBg;
void main() {
  if (dot(vWorld, uClip.xyz) > uClip.w) discard;
  vec3 n = normalize(vNormal);
  vec3 l1 = normalize(vec3(0.4, 0.7, 0.8));
  vec3 l2 = normalize(vec3(-0.5, -0.3, -0.6));
  float d1 = max(dot(n, l1), 0.0);
  float d2 = max(dot(n, l2), 0.0);
  vec3 col = uColor * (0.28 + 0.62 * d1 + 0.22 * d2);
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
void main() {
  gl_Position = uProj * uView * uModel * vec4(aPos, 1.0);
}`;

const LINE_FRAG = `
precision mediump float;
uniform vec3 uColor;
void main() { gl_FragColor = vec4(uColor, 1.0); }`;

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
void main() {
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
function thickVerts(segs: number[]): Float32Array {
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
 * motion per unit of the param — see backend sensitivity `shifts`). */
export interface DragHandle {
  face: number;
  shift: Vec3;
  dr: number;         // radius change per unit, for a cylinder face (else 0)
  value: number;      // the param's current value
  moves: number[];    // faces the param changes — not snap targets
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
  /** Set the dimension overlay (empty to clear). Reported back via onDims. */
  setDims(dims: DimAnchor[]): void;
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
   *  through it. null shows the part again. */
  setPreviewMesh(p: { mesh: ViewerMesh; color: Vec3 } | null): void;
  /** Light one face of the part brightly, through anything in front (a
   *  dialog row being hovered); null for none. */
  hoverFace(index: number | null): void;
  /** A dialog covers `px` CSS px along the left of the view: draw the part
   *  centred in the rest (0 for the whole view). */
  setInset(px: number): void;
  dispose(): void;
}

/** A world axis as seen in the current view: unit direction (x right, y up,
 * z toward the viewer) — for drawing an orientation gizmo. */
export interface AxisDir { name: string; x: number; y: number; z: number; color: string }

export interface ViewerOpts {
  color?: [number, number, number];
  /** A click picked a face (null: empty space); `shift` adds to a selection. */
  onFacePick?: (face: FaceRange | null, mods: { shift: boolean }) => void;
  /** Called each frame with the view-space directions of the X/Y/Z axes. */
  onAxes?: (dirs: AxisDir[]) => void;
  /** Called each frame with the projected dimension overlay (see setDims). */
  onDims?: (dims: PlacedDim[]) => void;
  /** Called each frame with the projected drag handle (see setHandle). */
  onHandle?: (h: PlacedHandle | null) => void;
  /** A handle drag was released at a new param value. The preview stays up
   *  until the next update() / setHandle() / clearDragPreview(). */
  onHandleDrop?: (value: number) => void;
  /** The pointer is over a drawn sketch (null: left it); CSS px in the canvas. */
  onSketchHover?: (hit: { id: string; name: string; x: number; y: number } | null) => void;
  /** A drawn sketch was double-clicked. */
  onSketchOpen?: (id: string) => void;
}

export function createViewer(canvas: HTMLCanvasElement, opts: ViewerOpts = {}): Viewer {
  const color = opts.color ?? [0.62, 0.66, 0.72];
  const gl = canvas.getContext('webgl', { antialias: true, depth: true, preserveDrawingBuffer: true });
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

  const posBuf = gl.createBuffer()!;
  const normBuf = gl.createBuffer()!;
  const previewBuf = gl.createBuffer()!;   // the dragged face's offset triangles
  // an operation's candidate result (setPreviewMesh), drawn in place of the part
  const candPosBuf = gl.createBuffer()!;
  const candNormBuf = gl.createBuffer()!;
  let cand: { count: number; color: Vec3 } | null = null;
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
  const sketchBuf = gl.createBuffer()!;
  let sketchLines: SketchLines[] = [];
  let sketchRanges: { id: string; first: number; count: number }[] = [];
  let hoverSketch: string | null = null;
  const SKETCH_LINE: [number, number, number] = [0.25, 0.62, 1.0];
  const SKETCH_HOVER: [number, number, number] = [0.55, 0.82, 1.0];

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
  let thumbMode = false;   // when capturing a thumbnail: draw the solid only (no grid/overlays)
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
    if (!vertexCount || faces.length === 0) return null;
    const w = canvas.width, h = canvas.height;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const sx = px * dpr, sy = py * dpr;
    const { proj, view, model } = mvp(w, h);
    const pv = multiply(proj, multiply(view, model));
    const project = (i: number): [number, number, number] | null => {
      const x = meshPositions[i * 3]!, y = meshPositions[i * 3 + 1]!, z = meshPositions[i * 3 + 2]!;
      const cw = pv[3]! * x + pv[7]! * y + pv[11]! * z + pv[15]!;
      if (cw <= 0) return null;
      const cx = pv[0]! * x + pv[4]! * y + pv[8]! * z + pv[12]!;
      const cy = pv[1]! * x + pv[5]! * y + pv[9]! * z + pv[13]!;
      const cz = pv[2]! * x + pv[6]! * y + pv[10]! * z + pv[14]!;
      return [(cx / cw * 0.5 + 0.5) * w, (1 - (cy / cw * 0.5 + 0.5)) * h, cz / cw];
    };
    let bestDepth = Infinity, bestFace: FaceRange | null = null;
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
        if (depth < bestDepth) { bestDepth = depth; bestFace = f; }
      }
    }
    return bestFace;
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
  function placeHandle(toCss: (p: Vec3) => [number, number, boolean]): PlacedHandle | null {
    const f = handle && faceByIndex.get(handle.face);
    if (!handle || !f) return null;
    const p = add(f.center, scale(handle.shift, drag ? drag.t : 0));
    const [x, y, v1] = toCss(p);
    const [ax, ay, v2] = toCss(add(p, scale(handle.shift, handleArm() / Math.hypot(...handle.shift))));
    return {
      x, y, ax, ay, visible: v1 && v2, dragging: !!drag,
      value: drag ? drag.value : handle.value, snapFace: drag ? drag.snap : null,
    };
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

    gl!.bindBuffer(gl!.ARRAY_BUFFER, posBuf);
    gl!.enableVertexAttribArray(aPos);
    gl!.vertexAttribPointer(aPos, 3, gl!.FLOAT, false, 0, 0);
    gl!.bindBuffer(gl!.ARRAY_BUFFER, normBuf);
    gl!.enableVertexAttribArray(aNormal);
    gl!.vertexAttribPointer(aNormal, 3, gl!.FLOAT, false, 0, 0);

    // while a handle drag is previewed, its face is drawn moved (below), so
    // leave it out of the solid
    const df = drag && handle && !thumbMode ? faceByIndex.get(handle.face) ?? null : null;
    const showCand = cand && !thumbMode && !sketch;
    if (showCand) {
      gl!.bindBuffer(gl!.ARRAY_BUFFER, candPosBuf);
      gl!.vertexAttribPointer(aPos, 3, gl!.FLOAT, false, 0, 0);
      gl!.bindBuffer(gl!.ARRAY_BUFFER, candNormBuf);
      gl!.vertexAttribPointer(aNormal, 3, gl!.FLOAT, false, 0, 0);
      gl!.uniform3fv(uColor, cand!.color);
      if (cand!.count) gl!.drawArrays(gl!.TRIANGLES, 0, cand!.count);
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
      if (df) {
        gl!.drawArrays(gl!.TRIANGLES, 0, df.start);
        gl!.drawArrays(gl!.TRIANGLES, df.start + df.count, vertexCount - df.start - df.count);
      } else {
        gl!.drawArrays(gl!.TRIANGLES, 0, vertexCount);
      }
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
    if (!thumbMode && !sk) {
      gl!.lineWidth(1);
      drawLines(gridBuf, gridCount, [0.45, 0.48, 0.53]);
    }

    // highlight pass: bright, drawn over the solid (depth off so it's visible)
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

    // the extrude preview: faint through the part, bright where it's in front
    if (ghost && sk && !thumbMode) {
      gl!.useProgram(thickProg);
      gl!.uniformMatrix4fv(tPV, false, multiply(proj, multiply(view, model)));
      gl!.uniform2f(tHalfPx, w / 2, h / 2);
      gl!.uniform1f(tBias, 3e-5);
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
        return { key: d.key, label: d.label, x, y, ax, ay, visible: vis };
      }));
    }
    if (opts.onHandle && !thumbMode) opts.onHandle(placeHandle(cssProjector()));
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
    let best: SketchLines | null = null, bestD = 6;
    for (const s of sketchLines) {
      const g = s.segments;
      for (let i = 0; i + 5 < g.length; i += 6) {
        const [ax, ay, va] = toCss([g[i]!, g[i + 1]!, g[i + 2]!]);
        const [bx, by, vb] = toCss([g[i + 3]!, g[i + 4]!, g[i + 5]!]);
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
  let mode: 'none' | 'orbit' | 'handle' = 'none';
  let lastX = 0, lastY = 0;
  let downX = 0, downY = 0, moved = 0;
  const baseCursor = canvas.style.cursor;

  function overHandle(e: PointerEvent): boolean {
    const h = placeHandle(cssProjector());
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
    const f = handle && faceByIndex.get(handle.face);
    if (!drag || !handle || !f) return;
    const toCss = cssProjector();
    const [x0, y0] = toCss(f.center);
    const [x1, y1] = toCss(add(f.center, handle.shift));
    const sx = x1 - x0, sy = y1 - y0;
    const mx = e.clientX - drag.x0, my = e.clientY - drag.y0;
    const t = dragAmount([mx, my], [sx, sy]);
    if (t === null) return;
    let value = handle.value, snap: number | null = null;
    if (Math.hypot(mx, my) >= 3) {   // dead zone: a press alone doesn't jump to the grid
      value = snapToStep(handle.value + t, e.shiftKey ? 0.1 : 0.5);
      const hit = snapToPlane(f, handle.shift, t, Math.hypot(sx, sy), faces, handle.moves);
      if (hit) { value = snapToStep(handle.value + hit.t, 0.001); snap = hit.face; }
    }
    drag.value = value;
    drag.t = value - handle.value;
    drag.snap = snap;
    scheduleRender();
  }

  function endHandleDrag(cancel: boolean) {
    window.removeEventListener('keydown', onKey);
    canvas.style.cursor = baseCursor;
    if (!drag || !handle) return;
    if (cancel || drag.value === handle.value) drag = null;
    else { drag.pending = true; opts.onHandleDrop?.(drag.value); }
    scheduleRender();
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && drag && !drag.pending) { e.preventDefault(); endHandleDrag(true); }
  }

  function onDown(e: PointerEvent) {
    if (sketch) return;   // sketch mode: the sketcher owns the view
    lastX = e.clientX; lastY = e.clientY;
    downX = e.clientX; downY = e.clientY; moved = 0;
    canvas.setPointerCapture(e.pointerId);
    const f = handle && faceByIndex.get(handle.face);
    if (e.button === 0 && handle && f && !drag?.pending && overHandle(e)) {
      mode = 'handle';
      drag = { x0: e.clientX, y0: e.clientY, t: 0, value: handle.value, snap: null,
               motion: faceMotion(f, meshPositions, handle.shift, handle.dr), pending: false };
      canvas.style.cursor = 'grabbing';
      window.addEventListener('keydown', onKey);
      scheduleRender();
      return;
    }
    anim = null;   // grabbing the view stops a view animation where it is
    mode = 'orbit';
  }
  function onMove(e: PointerEvent) {
    if (mode === 'handle') { if (drag && !drag.pending) dragTo(e); return; }
    if (mode === 'none') {   // hover: show the handle is grabbable
      if (sketch) return;
      const onHandle = handle && !drag?.pending && overHandle(e);
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      const s = onHandle ? null : sketchAt(px, py);
      if ((s?.id ?? null) !== hoverSketch) { hoverSketch = s?.id ?? null; scheduleRender(); }
      opts.onSketchHover?.(s ? { id: s.id, name: s.name, x: px, y: py } : null);
      canvas.style.cursor = onHandle || s ? 'pointer' : baseCursor;
      return;
    }
    moved += Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY);
    // Z-up turntable; vertical is unlimited, so rolling past the poles shows the bottom
    q = orbit(q, e.clientX - lastX, e.clientY - lastY);
    lastX = e.clientX; lastY = e.clientY;
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
    if (was === 'orbit' && moved < 4 && opts.onFacePick) {  // a click, not a drag → pick a face
      const rect = canvas.getBoundingClientRect();
      opts.onFacePick(pick(downX - rect.left, downY - rect.top), { shift: e.shiftKey });  // caller sets selection
    }
  }
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    if (sketch) return;
    distance *= Math.exp(e.deltaY * 0.001);
    scheduleRender();
  }
  function onDblClick(e: MouseEvent) {
    if (sketch || !opts.onSketchOpen) return;
    const rect = canvas.getBoundingClientRect();
    const s = sketchAt(e.clientX - rect.left, e.clientY - rect.top);
    if (s) opts.onSketchOpen(s.id);
  }
  function onLeave() {
    if (hoverSketch) { hoverSketch = null; scheduleRender(); }
    opts.onSketchHover?.(null);
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
      selected = [];
      hovered = null;
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
    setPreviewMesh(p) {
      if (!p) { cand = null; scheduleRender(); return; }
      gl!.bindBuffer(gl!.ARRAY_BUFFER, candPosBuf);
      gl!.bufferData(gl!.ARRAY_BUFFER, new Float32Array(p.mesh.positions), gl!.STATIC_DRAW);
      gl!.bindBuffer(gl!.ARRAY_BUFFER, candNormBuf);
      gl!.bufferData(gl!.ARRAY_BUFFER, new Float32Array(p.mesh.normals), gl!.STATIC_DRAW);
      cand = { count: p.mesh.positions.length / 3, color: p.color };
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
      gl.deleteBuffer(ghostBuf);
      gl.deleteProgram(prog);
      gl.deleteProgram(lineProg);
      gl.deleteProgram(thickProg);
    },
  };
}
