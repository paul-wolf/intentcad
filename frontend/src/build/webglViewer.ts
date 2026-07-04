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

export interface Viewer {
  update(mesh: ViewerMesh): void;
  dispose(): void;
}

export function createViewer(canvas: HTMLCanvasElement, color = [0.62, 0.66, 0.72]): Viewer {
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

  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(0, 0, 0, 0);

  // orbit state
  let azimuth = 0.6;
  let elevation = -0.5;
  let distance = 5;
  let center: [number, number, number] = [0, 0, 0];
  let vertexCount = 0;

  function uploadMesh(mesh: ViewerMesh) {
    gl!.bindBuffer(gl!.ARRAY_BUFFER, posBuf);
    gl!.bufferData(gl!.ARRAY_BUFFER, new Float32Array(mesh.positions), gl!.STATIC_DRAW);
    gl!.bindBuffer(gl!.ARRAY_BUFFER, normBuf);
    gl!.bufferData(gl!.ARRAY_BUFFER, new Float32Array(mesh.normals), gl!.STATIC_DRAW);
    vertexCount = mesh.positions.length / 3;

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
    if (!vertexCount) return;

    const proj = perspective((45 * Math.PI) / 180, w / h, distance * 0.01, distance * 100);
    const view = translation(0, 0, -distance);
    const rot = multiply(rotationY(azimuth), rotationX(elevation));
    const model = multiply(rot, translation(-center[0], -center[1], -center[2]));

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

    gl!.drawArrays(gl!.TRIANGLES, 0, vertexCount);
  }

  // ── interaction ──
  let dragging = false;
  let lastX = 0, lastY = 0;
  function onDown(e: PointerEvent) {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  }
  function onMove(e: PointerEvent) {
    if (!dragging) return;
    azimuth += (e.clientX - lastX) * 0.01;
    elevation += (e.clientY - lastY) * 0.01;
    elevation = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, elevation));
    lastX = e.clientX; lastY = e.clientY;
    scheduleRender();
  }
  function onUp(e: PointerEvent) {
    dragging = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
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
    update(mesh: ViewerMesh) { uploadMesh(mesh); scheduleRender(); },
    dispose() {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('wheel', onWheel);
      gl.deleteBuffer(posBuf);
      gl.deleteBuffer(normBuf);
      gl.deleteProgram(prog);
    },
  };
}
