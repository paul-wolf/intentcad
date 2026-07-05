/**
 * Minimal dependency-free WebGL viewer for a static triangle-soup mesh
 * (flat positions + per-face normals, as returned by /api/build/).
 *
 * Deliberately not three.js — this only needs to draw one static solid with
 * orbit + zoom. Column-major 4x4 math, two light directions for winding-
 * independent shading, render-on-demand.
 */

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

function rotationX(rad: number): Mat4 {
  const c = Math.cos(rad), s = Math.sin(rad);
  const m = identity();
  m[5] = c; m[6] = s; m[9] = -s; m[10] = c;
  return m;
}

function rotationY(rad: number): Mat4 {
  const c = Math.cos(rad), s = Math.sin(rad);
  const m = identity();
  m[0] = c; m[2] = -s; m[8] = s; m[10] = c;
  return m;
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
void main() {
  vNormal = uNormal * aNormal;
  gl_Position = uProj * uView * uModel * vec4(aPos, 1.0);
}`;

const FRAG = `
precision mediump float;
varying vec3 vNormal;
uniform vec3 uColor;
void main() {
  vec3 n = normalize(vNormal);
  vec3 l1 = normalize(vec3(0.4, 0.7, 0.8));
  vec3 l2 = normalize(vec3(-0.5, -0.3, -0.6));
  float d1 = max(dot(n, l1), 0.0);
  float d2 = max(dot(n, l2), 0.0);
  vec3 col = uColor * (0.28 + 0.62 * d1 + 0.22 * d2);
  gl_FragColor = vec4(col, 1.0);
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

/** A face's triangle range in the mesh + its plane (for pick / highlight). */
export interface FaceRange {
  index: number; start: number; count: number;
  kind: string; area: number; center: [number, number, number]; normal: [number, number, number];
}

export interface Viewer {
  update(mesh: ViewerMesh, faces?: FaceRange[]): void;
  /** Highlight edges: flat GL_LINES vertices [x,y,z, x,y,z, ...] (pairs). */
  highlightEdges(segments: number[]): void;
  /** Highlight faces by inventory index. */
  selectFaces(indices: number[]): void;
  dispose(): void;
}

/** A world axis as seen in the current view: unit direction (x right, y up,
 * z toward the viewer) — for drawing an orientation gizmo. */
export interface AxisDir { name: string; x: number; y: number; z: number; color: string }

export interface ViewerOpts {
  color?: [number, number, number];
  onFacePick?: (face: FaceRange | null) => void;
  /** Called each frame with the view-space directions of the X/Y/Z axes. */
  onAxes?: (dirs: AxisDir[]) => void;
}

export function createViewer(canvas: HTMLCanvasElement, opts: ViewerOpts = {}): Viewer {
  const color = opts.color ?? [0.62, 0.66, 0.72];
  const gl = canvas.getContext('webgl', { antialias: true, depth: true });
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

  const posBuf = gl.createBuffer()!;
  const normBuf = gl.createBuffer()!;

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

  // coordinate frame: a ground grid on the engine's Z=0 plane + XYZ axes at the
  // origin, so the build123d coordinate system (Z up, mm) is explicit.
  const gridBuf = gl.createBuffer()!;
  const axisBuf = gl.createBuffer()!;
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
    const a = ext * 1.15;
    gl!.bindBuffer(gl!.ARRAY_BUFFER, axisBuf);
    gl!.bufferData(gl!.ARRAY_BUFFER, new Float32Array([0,0,0, a,0,0, 0,0,0, 0,a,0, 0,0,0, 0,0,a]), gl!.STATIC_DRAW);
  }

  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);  // so re-drawing a selected face's own triangles passes
  gl.clearColor(0, 0, 0, 0);

  // orbit state
  let azimuth = 0.6;
  let elevation = -0.5;
  let distance = 5;
  let center: [number, number, number] = [0, 0, 0];
  let vertexCount = 0;

  // face selection
  let meshPositions: number[] = [];
  let faces: FaceRange[] = [];
  let selected: number[] = [];
  const SELECT: [number, number, number] = [1.0, 0.62, 0.2];

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
    buildFrame(radius);
  }

  function mvp(w: number, h: number) {
    const proj = perspective((45 * Math.PI) / 180, w / h, distance * 0.01, distance * 100);
    const view = translation(0, 0, -distance);
    const rot = multiply(rotationY(azimuth), rotationX(elevation));
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
    gl!.clear(gl!.COLOR_BUFFER_BIT | gl!.DEPTH_BUFFER_BIT);
    // draw even with no solid, so the coordinate frame is always visible

    const { proj, view, model, rot } = mvp(w, h);

    gl!.useProgram(prog);
    gl!.uniformMatrix4fv(uProj, false, proj);
    gl!.uniformMatrix4fv(uView, false, view);
    gl!.uniformMatrix4fv(uModel, false, model);
    gl!.uniformMatrix3fv(uNormal, false, mat3Of(rot));
    gl!.uniform3fv(uColor, color);

    gl!.bindBuffer(gl!.ARRAY_BUFFER, posBuf);
    gl!.enableVertexAttribArray(aPos);
    gl!.vertexAttribPointer(aPos, 3, gl!.FLOAT, false, 0, 0);
    gl!.bindBuffer(gl!.ARRAY_BUFFER, normBuf);
    gl!.enableVertexAttribArray(aNormal);
    gl!.vertexAttribPointer(aNormal, 3, gl!.FLOAT, false, 0, 0);

    if (vertexCount) gl!.drawArrays(gl!.TRIANGLES, 0, vertexCount);

    // selected faces: re-draw their triangles in a tint (depthFunc LEQUAL lets
    // the identical geometry pass)
    if (selected.length) {
      gl!.uniform3fv(uColor, SELECT);
      const byIndex = new Map(faces.map((f) => [f.index, f]));
      for (const idx of selected) {
        const f = byIndex.get(idx);
        if (f) gl!.drawArrays(gl!.TRIANGLES, f.start, f.count);
      }
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

    // ground grid + XYZ axes (Z up), occluded by the solid where it's in front
    gl!.lineWidth(1);
    drawLines(gridBuf, gridCount, [0.45, 0.48, 0.53]);
    drawLines(axisBuf, 6, [0.85, 0.33, 0.33], 0, 2);  // X red
    drawLines(axisBuf, 6, [0.40, 0.70, 0.42], 2, 2);  // Y green
    drawLines(axisBuf, 6, [0.40, 0.55, 0.85], 4, 2);  // Z blue

    // highlight pass: bright, drawn over the solid (depth off so it's visible)
    if (lineVertexCount) {
      gl!.disable(gl!.DEPTH_TEST);
      gl!.lineWidth(2);
      drawLines(lineBuf, lineVertexCount, HIGHLIGHT);
      gl!.enable(gl!.DEPTH_TEST);
    }

    // report the view-space direction of each world axis (columns of the
    // rotation) so the UI can draw an orientation gizmo
    if (opts.onAxes) {
      opts.onAxes([
        { name: 'X', x: rot[0]!, y: rot[1]!, z: rot[2]!, color: '#d95555' },
        { name: 'Y', x: rot[4]!, y: rot[5]!, z: rot[6]!, color: '#5fb36a' },
        { name: 'Z', x: rot[8]!, y: rot[9]!, z: rot[10]!, color: '#6a8cd9' },
      ]);
    }
  }

  // ── interaction ──
  let dragging = false;
  let lastX = 0, lastY = 0;
  let downX = 0, downY = 0, moved = 0;
  function onDown(e: PointerEvent) {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    downX = e.clientX; downY = e.clientY; moved = 0;
    canvas.setPointerCapture(e.pointerId);
  }
  function onMove(e: PointerEvent) {
    if (!dragging) return;
    moved += Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY);
    azimuth += (e.clientX - lastX) * 0.01;
    elevation += (e.clientY - lastY) * 0.01;
    elevation = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, elevation));
    lastX = e.clientX; lastY = e.clientY;
    scheduleRender();
  }
  function onUp(e: PointerEvent) {
    dragging = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (moved < 4 && opts.onFacePick) {  // a click, not a drag → pick a face
      const rect = canvas.getBoundingClientRect();
      opts.onFacePick(pick(downX - rect.left, downY - rect.top));  // caller sets selection
    }
  }
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    distance *= Math.exp(e.deltaY * 0.001);
    scheduleRender();
  }
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  const ro = new ResizeObserver(() => scheduleRender());
  ro.observe(canvas);

  return {
    update(mesh: ViewerMesh, facesArg?: FaceRange[]) {
      uploadMesh(mesh);
      meshPositions = mesh.positions;
      faces = facesArg ?? [];
      selected = [];
      scheduleRender();
    },
    highlightEdges(segments: number[]) {
      gl!.bindBuffer(gl!.ARRAY_BUFFER, lineBuf);
      gl!.bufferData(gl!.ARRAY_BUFFER, new Float32Array(segments), gl!.DYNAMIC_DRAW);
      lineVertexCount = segments.length / 3;
      scheduleRender();
    },
    selectFaces(indices: number[]) { selected = indices; scheduleRender(); },
    dispose() {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('wheel', onWheel);
      gl.deleteBuffer(posBuf);
      gl.deleteBuffer(normBuf);
      gl.deleteBuffer(lineBuf);
      gl.deleteBuffer(gridBuf);
      gl.deleteBuffer(axisBuf);
      gl.deleteProgram(prog);
      gl.deleteProgram(lineProg);
    },
  };
}
